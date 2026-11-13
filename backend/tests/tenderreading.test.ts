import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import { config } from '../src/config.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import * as business from '../src/domain/business.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { checkTenderReading, confirmReading, packText, readTenderPack, type InvitationFromReading } from '../src/domain/tenderreading.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as perception from '../src/engines/perception.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { ingestFile, packText as packTextOf } from '../src/evidence/pipeline.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';

/**
 * The tender pack, read together in one run.
 *
 * The fixture is the Conwy pack's own wording — the Waterloo Cottage retaining
 * wall, ERCF2509N: the instructions' timetable and return checklist, and the
 * questionnaire's seven scored questions with their 1,000-word limit. The model
 * is a stand-in that returns what a correct reading of those words is, because
 * no provider is called from a test; what is proved here is everything the
 * platform does around the model — what it is sent, what is filed, what the
 * checks catch, and what confirming records. Whether a real model reads the
 * pack this well is a separate question this file cannot answer.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let projectId: string;
const requests: ProviderRequest[] = [];
let reading: Record<string, unknown>;

function reasoningStub(): AIProviderAdapter {
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: true,
    estimateCostMinor: () => 25,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      // A drafting request is answered with prose; anything else is the reading.
      const drafting = typeof request.task === 'string' && request.task.includes('one section of a construction tender submission');
      const output = drafting
        ? { body: ['We will replace the retaining wall at Waterloo Cottage with soil nails and a masonry facing.'] }
        : reading;
      return { provider: 'OPENAI', modelClass: 'reasoning-standard', output, rawCostMinor: 25, latencyMs: 6, confidence: 0.88 };
    },
  };
}

/** Volume 1, the instructions to tenderers — the passages a reading draws on. */
const ITT_DOCX = docxOf(
  paragraph('Volume 1 – Instructions to Tenderers, Waterloo Cottage Retaining Wall Replacement') +
    paragraph('Contract reference ERCF2509N. Conwy County Borough Council, Environment, Road and Facilities. October 2026.') +
    paragraph('1.4 Procurement Timetable') +
    paragraph('22/10/2026 Notice published on sell2wales.gov.wales.') +
    paragraph('THURSDAY 19/11/2026 16:00HRS Completed tender document return / tender submission date.') +
    paragraph('1.16 Return of Tenders') +
    paragraph('Any tender submitted and or received after the time specified above will not be considered. Paper submissions will not be accepted.') +
    paragraph('1.17 Assessment of Tenders') +
    paragraph('The selection of the Contractor will be on the basis of 30% Quality Assessment and 70% Price Assessment.') +
    paragraph('The contractor must provide evidence that their accreditation has been achieved or renewed within the last 12 months.') +
    paragraph('1.34 Checklist of documents to be provided with Tender return') +
    paragraph('Fully completed Price List;') +
    paragraph('Contractor’s Offer') +
    paragraph('Tender Programme;') +
    paragraph('Collusive Tendering Certificate;') +
    paragraph('Signed Freedom of Information Declaration;') +
    paragraph('Evidence of membership to a Safety Schemes in Procurement assessment scheme') +
    paragraph('Quality submission') +
    paragraph('2.3 Table 1 – Quality Criteria. The Contractors proposed approach and methodology for the delivery of the proposed work. 30%'),
);

/** Volume 2, the questionnaire: the seven scored questions and their limit. */
const CDQQ_DOCX = docxOf(
  paragraph('Volume 2 – Contract Data and Quality Questionnaire') +
    paragraph('Tenders returned with any sections or questions left unanswered are liable to be rejected without further consideration.') +
    paragraph('No more than 1000 words are required per answer') +
    paragraph('Q1 The Contractors proposed approach and methodology for the delivery of the proposed work.') +
    paragraph('Q2 The Contractor’s proposed approach to Project Management during execution of the works including key staff, duties and management and co-ordination of sub-contractors.') +
    paragraph('Q3 The Contractor’s proposed approach to managing Health and Safety for the works and protecting the environment.') +
    paragraph('Q4 The Contractor’s proposed approach to progress reporting and communication with Conwy County Borough Council during execution of the works, including the approach to reporting commercial issues.') +
    paragraph('Q5 The Contractor’s approach to managing the quality of output on site, checking and supervision of the works.') +
    paragraph('Q6 The Contractor’s perceived key risks in undertaking the works and the outline mitigation measures.') +
    paragraph('Q7 The Contractor’s outline programme for the works including details of: Start date, access dates, key dates and completion date.'),
);

const QUESTIONS: Array<[string, number, string]> = [
  ['Q1', 30, 'The Contractors proposed approach and methodology for the delivery of the proposed work.'],
  ['Q2', 10, 'The Contractor’s proposed approach to Project Management during execution of the works including key staff, duties and management and co-ordination of sub-contractors.'],
  ['Q3', 15, 'The Contractor’s proposed approach to managing Health and Safety for the works and protecting the environment.'],
  ['Q4', 15, 'The Contractor’s proposed approach to progress reporting and communication with Conwy County Borough Council during execution of the works, including the approach to reporting commercial issues.'],
  ['Q5', 10, 'The Contractor’s approach to managing the quality of output on site, checking and supervision of the works.'],
  ['Q6', 10, 'The Contractor’s perceived key risks in undertaking the works and the outline mitigation measures.'],
  ['Q7', 10, 'The Contractor’s outline programme for the works including details of: Start date, access dates, key dates and completion date.'],
];

const RETURNS: Array<[string, string]> = [
  ['R1', 'Fully completed Price List'],
  ['R2', 'Contractor’s Offer'],
  ['R3', 'Tender Programme'],
  ['R4', 'Collusive Tendering Certificate'],
  ['R5', 'Signed Freedom of Information Declaration'],
  ['R6', 'Quality submission'],
];

/** What a correct reading of the two documents above returns. */
function conwyReading(): Record<string, unknown> {
  return {
    reference: 'ERCF2509N',
    clientName: 'Conwy County Borough Council',
    returnBy: '2026-11-19',
    returnByLocal: '2026-11-19T16:00',
    returnTimeZone: null,
    clarificationLocal: null,
    siteVisitLocal: null,
    issuedOn: '2026-10-22',
    returnChannel: 'PORTAL',
    requirements: [
      {
        reference: 'SSIP',
        category: 'HEALTH_AND_SAFETY',
        requirement: 'Evidence of membership to a Safety Schemes in Procurement assessment scheme',
        mandatory: true,
        evidenceRequired: 'Accreditation achieved or renewed within the last 12 months',
        sourceQuote: 'Evidence of membership to a Safety Schemes in Procurement assessment scheme',
      },
      ...QUESTIONS.map(([reference, weight, text]) => ({
        reference,
        category: 'TECHNICAL',
        requirement: text,
        mandatory: false,
        weightingPercent: weight,
        wordLimit: 1000,
        evidenceRequired: 'A written answer',
        sourceQuote: text,
      })),
    ],
    deliverables: RETURNS.map(([reference, title]) => ({
      reference,
      title,
      mandatory: true,
      channel: 'PORTAL',
      sourceQuote: title,
    })),
    terms: { contractForm: 'NEC4 Engineering and Construction Short Contract' },
    omitted: [],
  };
}

const INVITATION: InvitationFromReading = {
  reference: 'ERCF2509N',
  clientName: 'Conwy County Borough Council',
  issuedAt: '2026-10-22T00:00:00.000Z',
  returnLocal: '2026-11-19T16:00',
  timeZone: 'Europe/London',
  timeZoneStated: false,
  channel: 'PORTAL',
};

const ctx = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId, { correlationId: 'pack-test' });
const governance = (who: string) => (): EngineContext =>
  platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { correlationId: 'pack-test' });

async function file(name: string, bytes: Buffer): Promise<void> {
  const hash = hashBytes(bytes);
  tenderintake.recordTenderDocument(ctx('qs'), { hash, filename: name });
  await store.put(seed.tenantId, hash, bytes, 'application/zip');
  await ingestFile(ctx('qs'), store, { hash, filename: name });
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-pack-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ reasoning: reasoningStub() }), store);
  seed = await seedDemoProject(platform);

  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  projectId = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
    portfolioId,
    name: 'Waterloo Cottage retaining wall',
    sectorType: 'TRANSPORT',
    assetType: 'Retaining wall',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Conwy' },
    contractValueMinor: 0,
    currency: 'GBP',
    plannedStart: '2027-01-18',
    plannedCompletion: '2027-04-09',
  }).projectId;
  const pm = platform.context(seed.users.pm!.auth, projectId);
  const { packageId } = structure.createScopePackage(pm, {
    name: 'Retaining wall',
    discipline: 'CIVILS',
    scopeOfWorks: 'Replacement of the retaining wall with soil nails and masonry facing.',
    inclusions: ['Soil nails'],
    exclusions: [],
    acceptanceCriteria: ['Engineer sign-off'],
    estimatedValueMinor: 30_000_000,
    designResponsibility: 'CLIENT',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined' });
  structure.assessDesignMaturity(pm, {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 90, frozen: true }],
    informationGaps: [],
    assessorNotes: 'Priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'TENDER', justification: 'Priceable' });
  reading = conwyReading();
});

after(() => rmSync(directory, { recursive: true, force: true }));

describe('reading the whole tender pack in one run', () => {
  it('refuses before calling anybody when the project holds no readable document', async () => {
    await assert.rejects(readTenderPack(ctx('qs')), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'NO_PACK');
      return true;
    });
    assert.equal(requests.length, 0, 'nothing was sent');
  });

  it('sends every document together, each under its own heading, in one request', async () => {
    await file('ERCF2509N 05 Volume 1 - ITT.docx', ITT_DOCX);
    await file('ERCF2509N 05 Volume 2 - CDQQ.docx', CDQQ_DOCX);

    const pack = packText(ctx('qs'));
    assert.equal(pack.files.length, 2);
    assert.match(pack.text, /=== Document: ERCF2509N 05 Volume 1 - ITT\.docx/);
    assert.match(pack.text, /=== Document: ERCF2509N 05 Volume 2 - CDQQ\.docx/);

    const read = await readTenderPack(ctx('qs'), { today: '2026-10-25' });
    assert.equal(requests.length, 1, 'one request for the whole pack, not one per document');
    const sent = JSON.stringify(requests[0]);
    assert.match(sent, /19\/11\/2026 16:00HRS/, 'the instructions were sent');
    assert.match(sent, /No more than 1000 words are required per answer/, 'the questionnaire was sent with them');

    const draft = platform.ledger.require({ refType: 'PerceptionDraft', refId: read.draftId }).state;
    assert.equal(draft.status, 'DRAFT', 'a reading of the pack is a draft like any other');
    assert.equal(draft.textSource, 'TENDER_PACK');
    assert.deepEqual(
      (draft.packFiles as Array<{ filename: string }>).map((entry) => entry.filename),
      ['ERCF2509N 05 Volume 1 - ITT.docx', 'ERCF2509N 05 Volume 2 - CDQQ.docx'],
      'the draft names the documents it was read from',
    );
  });

  it('passes a correct reading, noting only that the invitation states no zone', async () => {
    const read = await readTenderPack(ctx('qs'), { today: '2026-10-25' });
    const checks = read.checks as ReturnType<typeof checkTenderReading>;
    assert.equal(checks.attention, 0, JSON.stringify(checks.checks));
    assert.deepEqual(checks.checks.map((check) => check.id), ['ZONE_NOT_STATED']);
    const draft = platform.ledger.require({ refType: 'PerceptionDraft', refId: read.draftId }).state;
    assert.deepEqual(draft.checks, checks, 'the checks are filed with the draft, for the review to show');
  });

  it('is quoted from the text it will send, not as an empty request', () => {
    const route = ROUTES.find((entry) => entry.pattern === '/v1/projects/:projectId/tender/read-pack')!;
    assert.equal(route.ai?.capability, 'REASONING');
    assert.equal(route.ai?.taskType, perception.textTaskType('ITT_REQUIREMENTS', 'TENDER_PACK'));
    assert.notEqual(route.ai?.taskType, perception.textTaskType('ITT_REQUIREMENTS', 'INGESTED_FILE'), 'priced apart from one file');
    const sized = route.ai!.quoteInputText!(ctx('qs'));
    assert.equal(sized, packText(ctx('qs')).text);

    // How a quote is sized from text is proved in quote.test.ts; what this
    // route adds is handing it the whole pack rather than nothing.
  });
});

describe('whether text can be read here, said apart from whether a page can be seen', () => {
  it('reports text reading available where a reasoning provider is configured, even with no vision provider', () => {
    const capability = perception.perceptionCapability(ctx('qs'));
    assert.equal(capability.textReading.available, true);
  });

  it('reports it unavailable on the local stand-in, which reads nothing', async () => {
    const bare = new Platform(undefined, new EvidenceStore(mkdtempSync(join(tmpdir(), 'construx-bare-'))));
    const bareSeed = await seedDemoProject(bare);
    const project = bareSeed.workingProjects[0]!.projectId;
    const capability = perception.perceptionCapability(bare.context(bareSeed.users.qs!.auth, project));
    assert.equal(capability.textReading.available, false);
    assert.match(String(capability.textReading.reason), /No reasoning provider/);
  });
});

describe('the checks, run in code on a reading before anybody sees it', () => {
  const pack = () => packText(ctx('qs')).text;
  const today = { today: '2026-10-25' };
  const ids = (extraction: Record<string, unknown>, options = today) =>
    checkTenderReading(extraction, pack(), options).checks.map((check) => check.id);

  it('catches weightings that do not add to 100', () => {
    const extraction = conwyReading();
    (extraction.requirements as Array<Record<string, unknown>>)[1]!.weightingPercent = 20; // Q1 misread as 20
    const result = checkTenderReading(extraction, pack(), today);
    const check = result.checks.find((entry) => entry.id === 'WEIGHTS_TOTAL')!;
    assert.match(check.title, /90%/);
    assert.equal(check.severity, 'ATTENTION');
  });

  it('catches a requirement whose words are nowhere in the documents', () => {
    const extraction = conwyReading();
    (extraction.requirements as Array<Record<string, unknown>>).push({
      reference: 'Q8',
      category: 'SOCIAL_VALUE',
      requirement: 'Community benefits plan delivering apprenticeships for local residents.',
      mandatory: false,
      evidenceRequired: 'Plan',
      sourceQuote: 'The Contractor shall deliver community benefits through apprenticeships.',
    });
    const check = checkTenderReading(extraction, pack(), today).checks.find((entry) => entry.id === 'NOT_IN_PACK')!;
    assert.deepEqual(check.references, ['Q8'], 'only the invented line, not the seven real ones');
  });

  it('traces a quote across a line break, a curly apostrophe and a different case', () => {
    const extraction = conwyReading();
    (extraction.requirements as Array<Record<string, unknown>>)[2]!.sourceQuote =
      "THE CONTRACTOR'S PROPOSED APPROACH TO PROJECT MANAGEMENT\nduring execution of the works";
    (extraction.requirements as Array<Record<string, unknown>>)[2]!.requirement = 'Project management (paraphrased)';
    assert.ok(!ids(extraction).includes('NOT_IN_PACK'));
  });

  it('catches a deadline that is not a date, and one already past', () => {
    assert.ok(ids({ ...conwyReading(), returnByLocal: 'Thursday afternoon' }).includes('DEADLINE_UNREAD'));
    assert.ok(ids(conwyReading(), { today: '2026-11-20' }).includes('DEADLINE_PAST'));
  });

  it('catches the last date for questions falling after the return', () => {
    assert.ok(ids({ ...conwyReading(), clarificationLocal: '2026-11-20T12:00' }).includes('QUESTIONS_AFTER_RETURN'));
    assert.ok(!ids({ ...conwyReading(), clarificationLocal: '2026-11-16T16:00' }).includes('QUESTIONS_AFTER_RETURN'));
  });

  it('catches a limit that is not a count, a reference used twice, and a pack with nothing to return', () => {
    const limits = conwyReading();
    (limits.requirements as Array<Record<string, unknown>>)[3]!.wordLimit = 1000.5;
    assert.ok(ids(limits).includes('LIMIT_UNREADABLE'));

    const twice = conwyReading();
    (twice.requirements as Array<Record<string, unknown>>)[4]!.reference = 'Q2';
    const repeated = checkTenderReading(twice, pack(), today).checks.find((entry) => entry.id === 'REFERENCE_REPEATED')!;
    assert.deepEqual(repeated.references, ['q2']);

    assert.ok(ids({ ...conwyReading(), deliverables: [] }).includes('NO_RETURNS'));
  });

  it('catches a return item that is not in the documents', () => {
    const extraction = conwyReading();
    (extraction.deliverables as Array<Record<string, unknown>>).push({
      reference: 'R9',
      title: 'Performance bond in the form at Appendix F',
      mandatory: true,
      sourceQuote: 'A performance bond of 10% is required',
    });
    const check = checkTenderReading(extraction, pack(), today).checks.find((entry) => entry.id === 'RETURN_NOT_IN_PACK')!;
    assert.deepEqual(check.references, ['R9']);
  });

  it('says every check passed when nothing is wrong, zone stated', () => {
    const result = checkTenderReading({ ...conwyReading(), returnTimeZone: 'Europe/London' }, pack(), today);
    assert.deepEqual(result.checks, []);
    assert.match(result.summary, /Every check passed/);
  });
});

describe('confirming the reading records the invitation, the matrix and the returns together', () => {
  let draftId: string;

  before(async () => {
    draftId = (await readTenderPack(ctx('qs'), { today: '2026-10-25' })).draftId;
  });

  it('refuses an invitation chosen and one to record in the same breath', async () => {
    await assert.rejects(
      confirmReading(ctx('qs'), governance('qs'), { draftId, invitationId: 'x', invitation: INVITATION }),
      (error: Error & { code?: string }) => error.code === 'INVITATION_TWICE',
    );
  });

  it('refuses an impossible deadline through the invitation’s own rule, and leaves no matrix behind', async () => {
    await assert.rejects(
      confirmReading(ctx('qs'), governance('qs'), {
        draftId,
        invitation: { ...INVITATION, issuedAt: '2026-11-20T00:00:00.000Z' },
      }),
      (error: Error & { code?: string }) => error.code === 'DEADLINE_BEFORE_ISSUE',
    );
    assert.equal(platform.ledger.require({ refType: 'PerceptionDraft', refId: draftId }).state.status, 'DRAFT');
    assert.equal(platform.ledger.listByTenant(seed.tenantId, 'TenderInvitation').filter((r) => r.state.reference === 'ERCF2509N').length, 0);
  });

  it('records the invitation, then builds one matrix and one return register against it', async () => {
    const confirmed = await confirmReading(ctx('qs'), governance('qs'), { draftId, invitation: INVITATION });
    assert.equal(confirmed.result.invitationRecorded, true);
    const invitationId = String(confirmed.result.invitationId);

    const opportunities = platform.ledger.listByTenant(seed.tenantId, 'Opportunity').filter((r) => r.state.projectId === projectId);
    assert.equal(opportunities.length, 1, 'the refused attempt left one pursuit, reused rather than doubled');
    assert.equal(opportunities[0]!.state.title, 'Waterloo Cottage retaining wall', 'titled from the project');

    const invitation = platform.ledger.require({ refType: 'TenderInvitation', refId: invitationId }).state;
    assert.equal(invitation.reference, 'ERCF2509N');
    assert.equal((invitation.issue as { channel: string }).channel, 'PORTAL');
    assert.equal((invitation.deliverables as unknown[]).length, RETURNS.length);
    assert.equal(invitation.analysisId, confirmed.result.analysisId, 'the matrix is bound to the invitation');

    const analysis = platform.ledger.require({ refType: 'ITTAnalysis', refId: String(confirmed.result.analysisId) }).state;
    const matrix = analysis.matrix as Array<{ reference: string; weightingPercent?: number }>;
    assert.equal(matrix.length, 8, 'the SSIP requirement and the seven scored questions');
    assert.equal(
      matrix.reduce((sum, line) => sum + (line.weightingPercent ?? 0), 0),
      100,
      'the weightings carried through as read',
    );
    assert.equal(platform.ledger.require({ refType: 'PerceptionDraft', refId: draftId }).state.status, 'CONFIRMED');
  });

  it('files a second reading against the invitation already recorded, never a second one', async () => {
    const second = (await readTenderPack(ctx('qs'), { today: '2026-10-25' })).draftId;
    const confirmed = await confirmReading(ctx('qs'), governance('qs'), { draftId: second, invitation: INVITATION });
    assert.equal(confirmed.result.invitationRecorded, false);
    const invitations = platform.ledger
      .listByTenant(seed.tenantId, 'TenderInvitation')
      .filter((record) => record.state.reference === 'ERCF2509N');
    assert.equal(invitations.length, 1);
  });

  it('drafts every scored answer with the tender documents in view, one answer per call', async () => {
    const analysisId = String(
      platform.ledger.listByTenant(seed.tenantId, 'TenderInvitation').find((r) => r.state.reference === 'ERCF2509N')!.state.analysisId,
    );
    const { pack } = bidresponse.planBidResponse(ctx('qs'), { analysisId });
    const listed = bidresponse.bidResponsePosition(ctx('qs')).packs.find((entry) => entry.id === pack.id)!;
    assert.equal(listed.basis, 'SCORED_QUESTIONS');
    assert.equal(listed.toWrite, 7, 'the seven scored questions, published for "draft every remaining answer"');
    assert.equal(bidresponse.plannedSections(ctx('qs'), pack.id), 7);

    // What the console does: the one-answer route, called until none remain.
    // An answer carries the firm's commercial position, so the vendor has to be
    // cleared for it, as a deployment does with AI_PROVIDER_CLEARANCE.
    const before = requests.length;
    const previous = config.ai.providerClearance.OPENAI;
    config.ai.providerClearance.OPENAI = 'COMMERCIAL_L3';
    try {
      let remaining = 7;
      while (remaining > 0) remaining = (await bidresponse.writeNextSection(ctx('qs'), { packId: pack.id })).remaining;
    } finally {
      if (previous === undefined) delete config.ai.providerClearance.OPENAI;
      else config.ai.providerClearance.OPENAI = previous;
    }
    const drafting = requests.slice(before);
    assert.equal(drafting.length, 7, 'one call per answer');
    for (const request of drafting) {
      const payload = request.payload as { tenderDocuments?: string; limit?: { words?: number } };
      assert.match(String(payload.tenderDocuments), /=== Document: ERCF2509N 05 Volume 1 - ITT\.docx/);
      assert.match(String(payload.tenderDocuments), /19\/11\/2026 16:00HRS/, 'each answer sees the instructions');
      assert.equal(payload.limit?.words, 1000, 'and its own word limit');
    }
    assert.equal(bidresponse.plannedSections(ctx('qs'), pack.id), 0);
    // A press with nothing left spends nothing.
    const extra = await bidresponse.writeNextSection(ctx('qs'), { packId: pack.id });
    assert.equal(extra.written, null);
    assert.equal(requests.length, before + 7);
  });

  it('quotes each answer from the documents it sends', () => {
    const route = ROUTES.find((entry) => entry.pattern === '/v1/projects/:projectId/bid-responses/:packId/sections')!;
    assert.equal(route.ai!.quoteInputText!(ctx('qs')), bidresponse.draftingDocuments(ctx('qs')).text);
    const redraft = ROUTES.find((entry) => entry.pattern === '/v1/projects/:projectId/bid-responses/:packId/sections/:key/redraft')!;
    assert.equal(redraft.ai!.quoteInputText!(ctx('qs')), bidresponse.draftingDocuments(ctx('qs')).text);
  });

  it('leaves whole documents out by name when a pack is larger than an answer is drafted with', () => {
    const whole = packTextOf(ctx('qs'));
    const capped = packTextOf(ctx('qs'), { maxCharacters: whole.files[0]!.characters + 200 });
    assert.equal(capped.files.length, 1, 'the first document fits, whole');
    assert.deepEqual(capped.omitted, [whole.files[1]!.filename], 'the second is named, not cut');
    assert.ok(!capped.text.includes('=== Document: ' + whole.files[1]!.filename));
    assert.ok(bidresponse.DRAFTING_PACK_MAX >= 160_000);
  });

  it('refuses to file a reading onto a tender the business has walked away from', async () => {
    const opportunityId = String(
      platform.ledger.listByTenant(seed.tenantId, 'Opportunity').find((r) => r.state.projectId === projectId)!.refId,
    );
    const owner = governance('owner')();
    business.qualifyOpportunity(owner, opportunityId, {
      relevantExperience: 1, clientAttractiveness: 1, contractSize: 1, geography: 1, supplyChainCapacity: 1,
      competition: 1, marginOpportunity: 1, cashflowRisk: 1, strategicValue: 1, winProbability: 1,
    });
    business.decideBidNoBid(owner, opportunityId, { bid: false, rationale: 'Outside our capacity this winter' });

    const third = (await readTenderPack(ctx('qs'), { today: '2026-10-25' })).draftId;
    await assert.rejects(
      confirmReading(ctx('qs'), governance('qs'), { draftId: third, invitation: INVITATION }),
      (error: Error & { code?: string }) => error.code === 'TENDER_CLOSED',
    );
  });

  it('the confirm route carries the invitation through its schema', () => {
    const route = ROUTES.find((entry) => entry.pattern === '/v1/projects/:projectId/perception/:draftId/confirm')!;
    const properties = (route.schema as { properties: Record<string, { required?: string[] }> }).properties;
    assert.deepEqual(properties.invitation?.required, ['reference', 'clientName', 'issuedAt', 'returnLocal', 'timeZone', 'timeZoneStated', 'channel']);
  });
});
