import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as actions from '../src/domain/ims/actions.ts';
import * as agents from '../src/domain/ims/agents.ts';
import * as audits from '../src/domain/ims/audits.ts';
import { clausesFor } from '../src/domain/ims/clauses.ts';
import * as docs from '../src/domain/ims/documents.ts';
import * as ims from '../src/domain/ims/ims.ts';
import * as registers from '../src/domain/ims/registers.ts';
import * as review from '../src/domain/ims/review.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The management system's agents draft; a person decides. The model is a stub
 * answering each task from what it was sent, and slipping in one answer of each
 * kind the code must drop: a clause outside the standards, a role that does not
 * exist, a checklist item outside the audit, a minute for an input the review
 * does not have, a score of seven, an Act not on the list, a date in the past.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = async (fn: () => unknown, code: string) => assert.rejects(async () => fn(), (error: { code?: string }) => error.code === code, `expected ${code}`);
const of = (runId: string) => agents.agentProposals(company('pm')).filter((entry) => entry.runId === runId);

const PROCEDURE_TEXT =
  'Purpose: to control documented information so that the right revision is used everywhere. Scope: every controlled document. ' +
  'Responsibilities: the owner keeps it current; somebody other than the author approves it. Procedure: 1. Draft. 2. Approve. ' +
  '3. Issue to the roles named. 4. Each person acknowledges it. 5. Review it yearly. Records: the register. [to be confirmed: the document system used]';

function answer(request: ProviderRequest): Record<string, unknown> {
  const properties = Object.keys(((request.responseSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  const payload = request.payload as Record<string, any>;
  if (properties.includes('content')) {
    return { title: payload.title, purpose: 'Control of documented information', content: PROCEDURE_TEXT, clauses: ['ISO9001:7.5', 'ISO14001:7.5', 'ISO9001:99'], distribution: ['PM', 'QS', 'ASTRONAUT'] };
  }
  if (properties.length === 1 && properties[0] === 'clauses') {
    return { clauses: [{ clauseId: 'ISO9001:7.5', reason: 'Steps 1 to 5 control documented information' }, { clauseId: 'ISO9001:7.3', reason: 'Acknowledgement builds awareness of the procedure' }, { clauseId: 'ISO45001:7.5', reason: 'Not a standard this document serves' }] };
  }
  if (properties.includes('items')) {
    const clauses = (payload.clauses as Array<{ id: string }>).map((entry) => entry.id);
    return { items: [{ clauseId: clauses[0], question: 'Is the revision in use on site the revision in force?' }, { clauseId: 'ISO9001:8.4', question: 'Are suppliers approved before use?' }] };
  }
  if (properties.includes('rootCause')) {
    return { rootCause: 'Printed registers are not withdrawn when a revision is issued, because nobody is told of the issue', plannedActions: 'Read registers from site tablets; withdraw printed copies; add a weekly check' };
  }
  if (properties.includes('minutes')) {
    const keys = (payload.inputs as Array<{ key: string }>).map((entry) => entry.key);
    return {
      minutes: [...keys.map((key) => ({ key, text: `The figures for ${key} were reviewed; performance is as the summary shows and no change is needed.` })), { key: 'context', text: 'Invented market commentary the records do not hold.' }, { key: 'weather', text: 'Not an input of this review at all.' }],
      outputs: [{ kind: 'IMPROVEMENT', text: 'Extend banksman briefings to every site induction' }, { kind: 'PARTY', text: 'Not a kind of output' }],
    };
  }
  if (properties.includes('aspects')) {
    return {
      aspects: [
        { activity: 'Concrete washout', aspect: 'Alkaline washwater', impact: 'Pollution of surface water', condition: 'ABNORMAL', severity: 4, likelihood: 3, legalDriver: true, controls: 'Lined washout bay; no discharge to drains' },
        { activity: 'Refuelling plant', aspect: 'Diesel spill', impact: 'Ground contamination', condition: 'EMERGENCY', severity: 7, likelihood: 1, controls: 'Spill kits' },
        { activity: 'Concrete washout', aspect: 'Alkaline washwater', impact: 'Duplicate of the first', condition: 'NORMAL', severity: 2, likelihood: 2, controls: 'The same bay' },
      ],
    };
  }
  if (properties.includes('entries')) {
    return {
      entries: [
        { catalogueKey: 'EPA_1990', requirement: 'Duty of care for waste transfers', applicability: 'Every project produces construction waste', howComplied: 'Carriers checked; transfer notes kept two years' },
        { catalogueKey: 'MADE_UP_ACT_2025', requirement: 'An Act the model invented', applicability: 'Applies to nothing real', howComplied: 'Cannot be complied with' },
      ],
    };
  }
  if (properties.includes('objectives')) {
    return {
      objectives: [
        { standard: 'ISO45001', objective: 'Reduce near misses on haul roads across all projects', measure: 'Near misses on haul roads per quarter', target: '≤ 2', baseline: '1 (last 12 months)', dueOn: ims.addMonths(ims.today(), 12) },
        { standard: 'ISO14001', objective: 'A target already in the past', measure: 'Anything at all', target: '0', dueOn: '2020-01-01' },
      ],
    };
  }
  throw new Error(`The stub was asked something it does not answer: ${properties.join(', ')}`);
}

const stub: AIProviderAdapter = {
  name: 'OPENAI',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 25,
  healthy: () => true,
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: answer(request), rawCostMinor: 25, latencyMs: 5, confidence: 0.8 };
  },
};

before(async () => {
  platform = new Platform(new AIOrchestrator({ reasoning: stub }));
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS agents test', decidedBy: seed.users.operator!.id });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the procedure and clause agents', () => {
  let policyId: string;
  let procedureId: string;

  it('drafts a procedure from the policy, dropping a clause and a role that do not exist, and records nothing until accepted', async () => {
    const policy = docs.draftDocument(company('qaqc'), { type: 'POLICY', title: 'IMS policy', standards: ['ISO9001', 'ISO14001'], clauses: clausesFor('5.2', ['ISO9001', 'ISO14001']), ownerId: seed.users.owner!.id, content: 'We commit to meeting requirements, protecting the environment, and controlling what we write down.' });
    policyId = policy.id;
    docs.approveDocument(company('safety'), policyId, { note: 'Approved' });
    await refused(() => agents.draftProcedure(company('pm'), { title: 'Document control', standards: ['ISO9001'] }), 'IMS_AGENT_BRIEF');
    const before = docs.documents(company('pm')).length;
    const run = await agents.draftProcedure(company('pm'), { title: 'Control of documented information', standards: ['ISO9001', 'ISO14001'], policyDocumentId: policyId });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1, 'the clause that does not exist');
    const [entry] = of(run.runId);
    assert.deepEqual(entry!.payload.clauses, ['ISO9001:7.5', 'ISO14001:7.5']);
    assert.deepEqual(entry!.payload.distribution, ['PM', 'QS'], 'the role that does not exist is gone');
    assert.equal(docs.documents(company('pm')).length, before, 'nothing recorded yet');
    const event = platform.ledger.eventsForEntity({ refType: 'ImsAgentProposal', refId: entry!.id })[0]!;
    assert.equal(event.actor.refType, 'AI');
  });

  it('accepts it, with the person’s edit, as a draft somebody else must approve', () => {
    const entry = agents.agentProposals(company('pm')).find((proposal) => proposal.kind === 'PROCEDURE')!;
    const decided = agents.decideProposal(company('pm'), people(), entry.id, { decision: 'ACCEPT', ownerId: seed.users.qaqc!.id, edits: { title: 'Control of documented information (site and office)' } });
    procedureId = decided.result!.refId;
    const document = docs.documentOf(company('pm'), procedureId);
    assert.equal(document.title, 'Control of documented information (site and office)');
    assert.equal(document.status, 'DRAFT');
    assert.equal(document.ownerId, seed.users.qaqc!.id);
    assert.equal(document.revisions[0]!.draftedByAgent, true);
    assert.equal(document.revisions[0]!.author, seed.users.pm!.id, 'the accepting person is the author');
    assert.throws(() => docs.approveDocument(company('pm'), procedureId, { note: 'Self' }), (error: { code?: string }) => error.code === 'ACCESS_DENIED' || error.code === 'IMS_APPROVAL_SAME_PERSON');
    assert.throws(() => agents.decideProposal(company('pm'), people(), entry.id, { decision: 'REJECT' }), (error: { code?: string }) => error.code === 'IMS_AGENT_PROPOSAL_DECIDED');
    assert.throws(() => agents.decideProposal(company('pm'), people(), entry.id, { decision: 'ACCEPT', edits: { clauses: 'x' } }), (error: { code?: string }) => error.code === 'IMS_AGENT_PROPOSAL_DECIDED');
  });

  it('maps a document’s clauses, dropping one of a standard it does not serve, as a redraft', async () => {
    docs.approveDocument(company('safety'), procedureId, { note: 'Approved' });
    const run = await agents.mapClauses(company('qaqc'), { documentId: procedureId });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1);
    const [entry] = of(run.runId);
    assert.throws(() => agents.decideProposal(company('pm'), people(), entry!.id, { decision: 'ACCEPT', edits: { clauses: 'ISO9001:9.1' } }), (error: { code?: string }) => error.code === 'IMS_AGENT_EDIT');
    agents.decideProposal(company('qaqc'), people(), entry!.id, { decision: 'ACCEPT' });
    const document = docs.documentOf(company('pm'), procedureId);
    assert.ok(document.revisions.some((revision) => revision.status === 'DRAFT'), 'a mapping change is a draft to approve');
    assert.deepEqual(document.clauses, ['ISO9001:7.5', 'ISO9001:7.3']);
  });
});

describe('the audit, action and review agents', () => {
  it('drafts an audit checklist within its scope', async () => {
    const audit = audits.planAudit(company('qaqc'), people(), { title: 'Document control', standards: ['ISO9001'], clauses: ['ISO9001:7.5'], plannedOn: '2099-01-10', leadAuditorId: seed.users.pm!.id });
    const run = await agents.draftChecklist(company('pm'), { auditId: audit.id });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1, 'the question on a clause outside the audit');
    agents.decideProposal(company('pm'), people(), of(run.runId)[0]!.id, { decision: 'ACCEPT' });
    assert.equal(audits.auditOf(company('pm'), audit.id).checklist.length, 1);
  });

  it('proposes a root cause the person edits before accepting, and a corrective action can then be done', async () => {
    const action = actions.raiseAction(company('qaqc'), { kind: 'CORRECTIVE', source: { kind: 'COMPLAINT', label: 'Client complaint: wrong drawing revision on site' }, standards: ['ISO9001'], description: 'A superseded drawing was used to set out the drainage', ownerId: seed.users.qaqc!.id, dueOn: '2099-02-01' });
    const run = await agents.proposeRootCause(company('qaqc'), { actionId: action.id });
    agents.decideProposal(company('qaqc'), people(), of(run.runId)[0]!.id, { decision: 'ACCEPT', edits: { plannedActions: 'Registers read from site tablets only; printed copies withdrawn; weekly check by the site manager' } });
    const updated = actions.actionOf(company('pm'), action.id);
    assert.match(updated.rootCause!, /nobody is told/);
    assert.match(updated.plannedActions!, /weekly check by the site manager/);
    actions.implementAction(company('qaqc'), action.id, { note: 'Tablets issued; copies withdrawn' });
  });

  it('drafts the review minutes from the frozen figures only, filling only what nobody has minuted', async () => {
    const opened = review.openReview(company('qaqc'), people(), { periodFrom: ims.addMonths(ims.today(), -12), periodTo: ims.today(), heldOn: ims.today(), chairId: seed.users.owner!.id });
    review.minuteInput(company('qaqc'), opened.id, { key: 'objectives', text: 'Written by a person before the agent ran: objectives to be set this year.' });
    const run = await agents.draftReviewMinutes(company('qaqc'), { reviewId: opened.id });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 3, 'the minute for an input with no figures, the input that does not exist, the output of no kind');
    agents.decideProposal(company('qaqc'), people(), of(run.runId)[0]!.id, { decision: 'ACCEPT' });
    const after = review.reviewOf(company('pm'), opened.id);
    assert.equal(after.minutes.objectives, 'Written by a person before the agent ran: objectives to be set this year.', 'the person’s minute stands');
    assert.equal(after.minutes.context, undefined, 'left for the meeting');
    assert.equal(after.outputs.length, 1);
    assert.throws(() => review.approveReview(company('owner'), opened.id, { note: 'Approve' }), (error: { code?: string }) => error.code === 'IMS_REVIEW_INCOMPLETE', 'the inputs the records cannot hold still need a person');
  });
});

describe('the register agents', () => {
  it('proposes aspects, dropping an impossible score and a duplicate, one proposal each', async () => {
    const run = await agents.proposeAspects(company('safety'), { activities: 'Groundworks, concrete pours and washout, refuelling of plant, waste segregation' });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 2);
    agents.decideProposal(company('safety'), people(), of(run.runId)[0]!.id, { decision: 'ACCEPT', edits: { controls: 'Lined washout bay emptied weekly by a licensed carrier' } });
    const aspect = registers.aspects(company('pm')).at(-1)!;
    assert.equal(aspect.draftedByAgent, true);
    assert.match(aspect.controls, /licensed carrier/);
  });

  it('proposes legal requirements only from the list', async () => {
    const run = await agents.proposeObligations(company('safety'), {});
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1, 'the invented Act');
    const [entry] = of(run.runId);
    assert.equal(entry!.payload.title, 'Environmental Protection Act 1990');
    agents.decideProposal(company('safety'), people(), entry!.id, { decision: 'ACCEPT' });
    assert.ok(registers.obligations(company('pm')).some((obligation) => obligation.catalogueKey === 'EPA_1990' && obligation.draftedByAgent));
  });

  it('proposes objectives from the position, dropping one dated in the past, and a reject records nothing', async () => {
    const run = await agents.proposeObjectives(company('pm'), people());
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1);
    const before = registers.objectives(company('pm')).length;
    agents.decideProposal(company('pm'), people(), of(run.runId)[0]!.id, { decision: 'REJECT', note: 'Haul roads are covered by the logistics plan' });
    assert.equal(registers.objectives(company('pm')).length, before);
  });

  it('refuses a reader, and counts the share of the work', async () => {
    await refused(() => agents.proposeAspects(company('planner'), { activities: 'Groundworks and concrete' }), 'ACCESS_DENIED');
    const { share } = agents.agentShare(company('pm'));
    assert.equal(share.proposed, share.accepted + share.rejected + share.pending);
    assert.ok(share.accepted >= 7);
    assert.equal(share.rejected, 1);
  });
});

describe('quoting the agents before they run', () => {
  it('declares each agent route on the Risk, Safety & Compliance engine, quoted against the company', () => {
    const agentRoutes = ROUTES.filter((route) => route.ai && route.pattern.startsWith('/v1/ims'));
    assert.equal(agentRoutes.length, 8);
    for (const route of agentRoutes) {
      assert.equal(route.ai!.engine, 'RISK_SAFETY', route.pattern);
      assert.equal(route.quoteScope, 'TENANT', route.pattern);
    }
    assert.ok(ROUTES.some((route) => route.method === 'GET' && route.pattern === '/v1/ims/agents/estimate'));
  });

  it('quotes a company-level AI action over HTTP — refused before this change — without spending anything', async () => {
    const user = platform.user(seed.users.pm!.id);
    const token = issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
    const response = await fetch(`${base}/v1/ai/quote`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method: 'POST', path: '/v1/ims/agents/aspects' }) });
    const quote = (await response.json()) as { engine?: string; taskType?: string; estimatedChargeMinor?: number };
    assert.equal(response.status, 200);
    assert.equal(quote.engine, 'RISK_SAFETY');
    assert.equal(quote.taskType, 'ims_aspects');
    assert.ok((quote.estimatedChargeMinor ?? 0) > 0);
  });
});
