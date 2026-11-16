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
import * as tenderregister from '../src/domain/tenderregister.ts';
import * as contractreview from '../src/domain/contractreview.ts';
import * as tenderscope from '../src/domain/tenderscope.ts';
import * as answercheck from '../src/domain/answercheck.ts';
import * as tenderbrief from '../src/domain/tenderbrief.ts';
import * as bidsignoff from '../src/domain/bidsignoff.ts';
import { setIssuerProfile } from '../src/group/profile.ts';
import * as bidreview from '../src/domain/bidreview.ts';
import * as buyerquestions from '../src/domain/buyerquestions.ts';
import * as matrixreview from '../src/domain/matrixreview.ts';
import * as tenderintel from '../src/domain/tenderintel.ts';
import * as safety from '../src/engines/safety.ts';
import { write } from '../src/engines/context.ts';
import { checkPriceListReading, checkTenderReading, confirmReading, packText, readTenderPack, type InvitationFromReading } from '../src/domain/tenderreading.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as perception from '../src/engines/perception.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { ingestFile, ingestedFiles, packText as packTextOf, priceListFromFile } from '../src/evidence/pipeline.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph, wordTable } from './fixtures/zip.ts';

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
let priceReading: Record<string, unknown>;
let packageId: string;

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
      const pricing = typeof request.task === 'string' && request.task.includes('bill of quantities or pricing schedule');
      const output = drafting
        ? { body: ['We will replace the retaining wall at Waterloo Cottage with soil nails and a masonry facing.'] }
        : pricing
          ? priceReading
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
    paragraph('2.3 Table 1 – Quality Criteria. The Contractors proposed approach and methodology for the delivery of the proposed work. 30%') +
    paragraph('3.2 The Contractor notifies a compensation event within eight weeks of becoming aware that the event has happened.') +
    paragraph('3.4 The Contractor is liable for design to the standard of fitness for purpose.') +
    paragraph('4.1 Soil nails: designed by the Employer’s engineer, supplied and installed by the Contractor, tested by the Contractor and witnessed by the Engineer.') +
    paragraph('4.2 The facing masonry shall be natural stone to match the existing.') +
    paragraph('4.3 Drawing ERCF-02 shows the facing as reconstituted stone blocks.'),
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

/** For one reading, Q6 reads differently — as a re-read of an amended questionnaire would. */
function reading_with_changed_q6(): { restore: () => void } {
  const requirements = reading.requirements as Array<Record<string, unknown>>;
  const q6 = requirements.find((line) => line.reference === 'Q6')!;
  const before = q6.requirement;
  q6.requirement = `${String(before)} (as amended)`;
  return { restore: () => void (q6.requirement = before) };
}

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
    // "18/01/2027 Contract commencement date. 09/04/2027 Contract completion date."
    worksStartOn: '2027-01-18',
    worksCompletionOn: '2027-04-09',
    worksPeriodDays: null,
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
        ...(reference === 'Q2' ? { subQuestions: ['Key staff and their duties', 'Management and co-ordination of sub-contractors'] } : {}),
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
    // What the pack says about itself.
    documentsListed: [
      { title: 'Volume 1 – Instructions to Tenderers', reference: 'Volume 1', revision: null, issuedOn: '2026-10-22', sourceQuote: 'Volume 1 – Instructions to Tenderers' },
      { title: 'Volume 2 – Contract Data and Quality Questionnaire', reference: 'Volume 2', revision: null, issuedOn: null, sourceQuote: 'Volume 2 – Contract Data and Quality Questionnaire' },
      { title: 'Volume 3 – Drawings', reference: 'Volume 3', revision: 'B', issuedOn: null, sourceQuote: null },
    ],
    documentsNotSupplied: [],
    precedence: null,
    evaluation: {
      qualityPercent: 30,
      pricePercent: 70,
      minimumQualityScore: null,
      scoringMethod: null,
      qualificationsPermitted: null,
      sourceQuote: 'The selection of the Contractor will be on the basis of 30% Quality Assessment and 70% Price Assessment.',
    },
    submissionRules: null,
    tenderValidityDays: null,
    awardOn: '2026-12-14',
    milestones: [{ label: 'Notice published', date: '2026-10-22', mandatory: false, sourceQuote: '22/10/2026 Notice published on sell2wales.gov.wales.' }],
    scope: [
      { reference: '4.1', workPackage: 'Retaining wall', description: 'Soil nails', design: 'CLIENT', supply: 'CONTRACTOR', install: 'CONTRACTOR', testApprove: 'CONTRACTOR', pricedIn: '990.1', sourceQuote: 'Soil nails: designed by the Employer’s engineer, supplied and installed by the Contractor' },
      { reference: '4.2', workPackage: 'Retaining wall', description: 'Masonry facing', design: 'NOT_STATED', supply: 'CONTRACTOR', install: 'CONTRACTOR', testApprove: 'NOT_STATED', pricedIn: null, sourceQuote: 'The facing masonry shall be natural stone to match the existing.' },
    ],
    discrepancies: [
      {
        subject: 'Facing stone',
        consequence: 'Natural stone costs several times reconstituted block.',
        statements: [
          { document: 'Volume 1', clause: '4.2', says: 'Natural stone to match the existing.', sourceQuote: 'The facing masonry shall be natural stone to match the existing.' },
          { document: 'Drawing ERCF-02', clause: '4.3', says: 'Reconstituted stone blocks.', sourceQuote: 'Drawing ERCF-02 shows the facing as reconstituted stone blocks.' },
        ],
      },
      { subject: 'One-sided', statements: [{ document: 'Volume 1', says: 'Only one side.' }] },
    ],
    contract: {
      form: 'NEC4 Engineering and Construction Short Contract',
      edition: null,
      options: [],
      amendmentsStated: true,
      amendmentsSupplied: false,
      clauses: [
        { topic: 'NOTICES', clause: '3.2', stated: 'A compensation event is notified within eight weeks.', value: 8, unit: 'weeks', sourceQuote: 'notifies a compensation event within eight weeks of becoming aware' },
        { topic: 'DESIGN_LIABILITY', clause: '3.4', stated: 'Design liability is fitness for purpose.', sourceQuote: 'liable for design to the standard of fitness for purpose' },
        { topic: 'LIABILITY_CAP', clause: '8.1', stated: 'Liability is unlimited.', sourceQuote: 'The Contractor’s liability is unlimited' },
      ],
    },
    omitted: [],
  };
}

/** The Conwy price list, as it sits in Volume 2: a table of items, units and quantities, the rates blank. */
const PRICE_ITEMS: Array<[string, string, string, number]> = [
  ['990.1', 'Establishment of temporary accommodation and equipment for the Contractor', 'Item', 1],
  ['990.5', 'Daily Maintenance of temporary scaffolding/propping', 'Day', 84],
  ['106.3', 'Maintenance and adjustment for closure of Waterloo Road at location shown on drawing ERCF2509N 05 T101', 'Day', 84],
  ['109.2', 'Vegetation clearance', 'm²', 350],
  ['202.2', 'DBM asphalt 125 Pen 20 mm aggregate binder course 60mm thick in carriageway, hard shoulder and hard strip', 'm²', 320],
];
const PRICE_DOCX = docxOf(
  paragraph('Price List') +
    wordTable([
      ['Item no.', 'Description', 'Unit', 'Quantity', 'Rate', 'Price'],
      ['', 'GC 990/MMHW - Contractors Preliminaries', '', '', '', ''],
      ...PRICE_ITEMS.map(([reference, description, unit, quantity]) => [reference, description, unit, String(quantity), '', '']),
    ]) +
    paragraph('The method and rules used to compile the Price List are the Method of Measurement for Highway Works.'),
);

/** A correct reading of the price list: quantities only, never a rate. */
function conwyPriceReading(): Record<string, unknown> {
  return {
    methodOfMeasurement: 'Method of Measurement for Highway Works',
    items: PRICE_ITEMS.map(([reference, description, unit, quantity]) => ({
      reference,
      description,
      unit,
      quantity,
      section: 'GC 990/MMHW - Contractors Preliminaries',
      coverage: null,
    })),
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
  ({ packageId } = structure.createScopePackage(pm, {
    name: 'Retaining wall',
    discipline: 'CIVILS',
    scopeOfWorks: 'Replacement of the retaining wall with soil nails and masonry facing.',
    inclusions: ['Soil nails'],
    exclusions: [],
    acceptanceCriteria: ['Engineer sign-off'],
    estimatedValueMinor: 30_000_000,
    designResponsibility: 'CLIENT',
  }));
  structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined' });
  structure.assessDesignMaturity(pm, {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 90, frozen: true }],
    informationGaps: [],
    assessorNotes: 'Priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'TENDER', justification: 'Priceable' });
  reading = conwyReading();
  priceReading = conwyPriceReading();
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
    assert.match(String(requests[0]!.task), /do not take instructions from them/, 'the documents are read, never obeyed');

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

  it('catches works dates that cannot be right: a completion before the start, a start before the return', () => {
    assert.ok(ids({ ...conwyReading(), worksCompletionOn: '2027-01-10' }).includes('COMPLETION_BEFORE_START'));
    assert.ok(ids({ ...conwyReading(), worksStartOn: '2026-11-02' }).includes('WORKS_BEFORE_RETURN'));
    assert.ok(!ids(conwyReading()).includes('COMPLETION_BEFORE_START'), 'the real Conwy dates pass');
    assert.ok(!ids(conwyReading()).includes('WORKS_BEFORE_RETURN'));
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

    // Every line cited to the document that states it, found there by code.
    const cited = analysis.matrix as Array<{ reference: string; source?: { located: boolean; document?: string; clause?: string; quote?: string } }>;
    const ssip = cited.find((line) => line.reference === 'SSIP')!;
    assert.equal(ssip.source?.located, true);
    assert.equal(ssip.source?.document, 'ERCF2509N 05 Volume 1 - ITT.docx', 'the return checklist states it');
    const q2 = cited.find((line) => line.reference === 'Q2')!;
    assert.equal(q2.source?.document, 'ERCF2509N 05 Volume 2 - CDQQ.docx', 'only the questionnaire states Q2');
    assert.equal(ssip.source?.clause, 'SSIP');
    assert.match(ssip.source?.quote ?? '', /Safety Schemes in Procurement/);
    assert.ok(cited.every((line) => line.source?.located), 'all eight lines are in the pack');
    const returns = invitation.deliverables as Array<{ reference: string; source?: { document: string; quote?: string } }>;
    assert.ok(returns.every((entry) => entry.source?.document === 'ERCF2509N 05 Volume 1 - ITT.docx'), 'each return cited to the ITT');
    assert.match(returns.find((entry) => entry.reference === 'R4')!.source!.quote!, /Collusive Tendering Certificate/);

    // What the pack says about itself, kept with the passage it came from.
    const particulars = analysis.particulars as {
      evaluation: { qualityPercent: number; pricePercent: number; source: { located: boolean; document: string } };
      awardOn: string;
      documentsListed: unknown[];
    };
    assert.equal(particulars.evaluation.qualityPercent, 30);
    assert.equal(particulars.evaluation.pricePercent, 70);
    assert.equal(particulars.evaluation.source.document, 'ERCF2509N 05 Volume 1 - ITT.docx');
    assert.equal(particulars.awardOn, '2026-12-14');
    assert.equal(particulars.documentsListed.length, 3);
  });

  it('reviews the contract clause by clause, and drafts the clauses it can cite into the tender review', () => {
    const review = contractreview.contractReviewForProject(ctx('qs'));
    assert.equal(review.form, 'NEC4 Engineering and Construction Short Contract');
    const byTopic = new Map(review.rows.map((row) => [row.topic, row]));
    assert.equal(byTopic.get('NOTICES')!.severity, 'MATERIAL', 'eight weeks is 56 days: not a short time bar');
    assert.equal(byTopic.get('DESIGN_LIABILITY')!.severity, 'SEVERE');
    assert.deepEqual(byTopic.get('DESIGN_LIABILITY')!.review, ['LEGAL', 'INSURANCE']);
    assert.equal(byTopic.get('LIABILITY_CAP')!.severity, 'SEVERE');
    assert.match(byTopic.get('LIABILITY_CAP')!.sourceText, /not found in the documents/);
    assert.match(byTopic.get('NOTICES')!.sourceText, /ERCF2509N 05 Volume 1 - ITT\.docx, 3\.2/);
    assert.ok(review.notStated.some((entry) => entry.topic === 'PAYMENT_CERTIFICATION' && /funded/.test(entry.why)));
    assert.ok(review.cannotCompare.some((line) => /amended but the amendments are not in it/.test(line)));
    assert.ok(review.cannotCompare.some((line) => /named without its edition/.test(line)));

    // The pack names no edition, so the review cannot be opened until somebody gives one.
    assert.throws(() => contractreview.draftContractReview(ctx('owner'), {}), (error: Error & { code?: string }) => error.code === 'CONTRACT_FORM_REQUIRED');
    const drafted = contractreview.draftContractReview(ctx('owner'), { edition: 'June 2017 (amended January 2023)' });
    assert.equal(drafted.opened, true);
    assert.equal(drafted.recorded, 2, 'the two clauses found in the documents');
    assert.deepEqual(drafted.skipped.map((entry) => entry.title), ['Liability caps and exclusions']);
    const record = platform.ledger.require({ refType: 'TenderReview', refId: drafted.reviewId }).state;
    const obligations = record.obligations as Array<{ reference: string; wording: string; status: string; response: string }>;
    const design = obligations.find((entry) => entry.reference === 'C-3.4')!;
    assert.equal(design.wording, 'liable for design to the standard of fitness for purpose', 'the contract’s own words, as printed');
    assert.equal(design.status, 'DRAFT', 'awaiting a legal or commercial owner');
    assert.equal(design.response, 'CLARIFICATION');
    // Again: nothing is added twice.
    assert.equal(contractreview.draftContractReview(ctx('owner'), {}).recorded, 0);
  });

  it('maps who does what and where it is priced, and registers where the documents disagree', () => {
    const scope = tenderscope.scopeReview(ctx('qs'));
    const nails = scope.rows.find((row) => row.reference === '4.1')!;
    assert.equal(nails.pricing, 'ITEM');
    assert.ok(nails.flags.some((flag) => /Done by others/.test(flag)), 'the client designs them: a dependency');
    const facing = scope.rows.find((row) => row.reference === '4.2')!;
    assert.equal(facing.pricing, 'NOT_PRICED');
    assert.ok(facing.flags.some((flag) => /Who designs it is not stated/.test(flag)));
    assert.ok(facing.flags.some((flag) => /a gap/.test(flag)));
    assert.equal(scope.discrepancies.length, 1, 'a single statement is not a discrepancy');
    const stone = scope.discrepancies[0]!;
    assert.equal(stone.id, 'DISC-FACING-STONE');
    assert.equal(stone.verified, true, 'both sides found in the documents');
    assert.match(stone.action, /Raise a clarification/);

    // Raised against it, the discrepancy carries the reference.
    const raised = tenderintel.raiseTenderClarification(ctx('qs'), {
      side: 'CLIENT',
      subject: 'Facing stone',
      question: 'Please confirm whether the facing is natural stone or reconstituted block.',
      links: { scopeItem: stone.id, document: 'Volume 1' },
    });
    assert.equal(tenderscope.scopeReview(ctx('qs')).discrepancies[0]!.clarification?.reference, raised.reference);

    // Onto the tender review's map: the unpriced facing is a gap there.
    const sent = tenderscope.sendScopeToReview(ctx('qs'), { edition: 'June 2017' });
    assert.deepEqual(sent.gaps.map((gap) => gap.reference), ['4.2']);
    assert.equal(sent.overlaps.length, 0);
  });

  it('recommends from everything on the record, with conditions, and proposes the risks the tender carries', () => {
    const review = bidreview.bidReview(ctx('qs'));
    assert.equal(review.read, true);
    assert.equal(review.recommendation, 'HOLD', 'Volume 3 is listed in the pack and was never uploaded');
    assert.ok(review.factors.some((factor) => factor.area === 'SCOPE_CERTAINTY' && factor.bearing === 'HOLD' && /Volume 3/.test(factor.finding)));
    assert.ok(review.factors.some((factor) => factor.area === 'MARGIN' && factor.bearing === 'NOT_KNOWN'), 'not priced yet: said, not assumed');
    const design = review.conditions.find((condition) => condition.id === 'COND-CONTRACT-DESIGN_LIABILITY')!;
    assert.equal(design.deadline, '2026-11-19', 'no questions deadline recorded, so the return date');
    assert.match(design.ifUnresolved, /Price the risk, or qualify the bid/);
    for (const condition of review.conditions) assert.ok(condition.owner && condition.deadline && condition.ifUnresolved, condition.id);
    assert.equal(new Set(review.risks.map((entry) => entry.source)).size, review.risks.length, 'each proposal is told apart by its source');
    assert.equal(new Set(review.risks.map((entry) => entry.id)).size, review.risks.length);
    const risk = review.risks.find((entry) => entry.id === 'RISK-CONTRACT-DESIGN_LIABILITY')!;
    assert.equal(risk.registered, false);

    // Registered with the source it cites, the proposal reads as registered.
    safety.registerRisk(ctx('pm'), {
      id: '',
      title: risk.title,
      category: risk.category,
      cause: risk.cause,
      allocation: risk.allocation,
      probability: 0.3,
      costImpact: { optimistic: 0, mostLikely: 500_000, pessimistic: 2_000_000 },
      scheduleImpactDays: { optimistic: 0, mostLikely: 0, pessimistic: 10 },
      projectValueMinor: 30_000_000,
      projectDurationDays: 80,
      source: risk.source,
      decisionDue: risk.decisionDue!,
    });
    assert.equal(bidreview.bidReview(ctx('qs')).risks.find((entry) => entry.id === risk.id)!.registered, true);
  });

  it('keeps the internal log off the buyer’s copy, drafts an extension only when warranted, and traces an answer back', () => {
    const raised = tenderintel.raiseTenderClarification(ctx('qs'), {
      side: 'CLIENT',
      subject: 'Key staff named in Q2',
      ambiguity: 'Volume 2 Q2 asks for key staff; the ITT does not say whether named individuals are required.',
      question: 'Please confirm whether Q2 requires named individuals or roles.',
      links: { document: 'ERCF2509N 05 Volume 2 - CDQQ.docx', requirement: 'Q2' },
      urgency: 'CRITICAL',
      impact: 'Decides whether Q2 can be answered without named staff.',
      owner: 'QS',
      interimTreatment: 'Answered with roles; no named staff.',
    });
    const schedule = buyerquestions.buyerSchedule(ctx('qs'));
    assert.equal(schedule.tenderReference, 'ERCF2509N');
    const row = schedule.rows.find((entry) => entry.tq === raised.reference)!;
    assert.match(row.cq, /^CQ-\d+$/);
    assert.match(row.ambiguity, /does not say whether named individuals/);
    assert.doesNotMatch(schedule.text, /CRITICAL|interim|no named staff|Decides whether/, 'nothing internal goes to the buyer');

    const extension = buyerquestions.extensionRequestDraft(ctx('qs'), { today: '2026-11-10', proposedLocal: '2026-11-26T16:00' });
    assert.equal(extension.warranted, true);
    assert.ok(extension.reasons.some((reason) => /Volume 3/.test(reason)));
    assert.ok(extension.reasons.some((reason) => /Key staff named in Q2/.test(reason)));
    assert.match(extension.text!, /extended to 2026-11-26 16:00/);

    tenderintel.recordClientAnswer(ctx('qs'), { clarificationId: raised.clarificationId, answer: 'Roles are sufficient.', answeredOn: '2026-11-12' });
    const impacts = buyerquestions.answerImpacts(ctx('qs'), raised.clarificationId);
    assert.ok(impacts.some((impact) => impact.kind === 'MATRIX_LINE' && impact.reference === 'Q2'));
    assert.ok(impacts.some((impact) => impact.kind === 'PRICE' && /Answered with roles/.test(impact.action)));
    const analysisId = String(platform.ledger.listByTenant(seed.tenantId, 'TenderInvitation').at(-1)!.state.analysisId);
    const q2 = matrixreview.matrixPosition(governance('qs')(), analysisId).lines.find((line) => line.reference === 'Q2')!;
    assert.match(q2.action, new RegExp(`The buyer answered ${raised.reference}`));
    assert.equal(q2.answered?.answer, 'Roles are sufficient.');
  });

  it('keeps a register of the documents and every date, and says what the pack lists that never arrived', () => {
    const register = tenderregister.tenderRegister(ctx('qs'));
    assert.equal(register.read, true);
    const itt = register.rows.find((row) => row.filename === 'ERCF2509N 05 Volume 1 - ITT.docx')!;
    assert.equal(itt.status, 'READ');
    assert.equal(itt.inReading, true);
    assert.equal(itt.inDrafting, true);
    assert.equal(itt.listedAs, 'Volume 1 – Instructions to Tenderers');
    assert.equal(itt.issuedOn, '2026-10-22');
    assert.deepEqual(register.listedNotUploaded.map((entry) => entry.title), ['Volume 3 – Drawings rev B']);
    assert.equal(register.evaluation?.qualityPercent, 30);
    assert.match(register.evaluation!.sourceText, /ERCF2509N 05 Volume 1 - ITT\.docx/);
    const labels = register.dates.map((row) => `${row.label}:${row.kind}`);
    assert.ok(labels.includes('Tender return:MANDATORY'), labels.join(', '));
    assert.ok(labels.includes('Anticipated award:INDICATIVE'));
    assert.ok(labels.includes('Works start:CONTRACT'));
    assert.ok(labels.includes('Notice published:INDICATIVE'));
    assert.deepEqual(register.conflicts, [], 'award before the works start, after the return: consistent');
    assert.match(register.summary, /1 listed in the pack but not uploaded/);
  });

  it('files a second reading against the invitation already recorded, never a second one', async () => {
    // Decisions taken on the first matrix: a waiver and an undertaking on Q7,
    // recorded straight onto the ledger so the test does not depend on today's
    // date against the fixture's return date; and one on a line whose wording
    // the second reading changes.
    const invitation = () =>
      platform.ledger.listByTenant(seed.tenantId, 'TenderInvitation').find((record) => record.state.reference === 'ERCF2509N')!.state;
    const firstId = String(invitation().analysisId);
    const first = platform.ledger.require({ refType: 'ITTAnalysis', refId: firstId });
    const q7 = (first.state.matrix as Array<{ reference: string; requirement: string }>).find((line) => line.reference === 'Q7')!;
    write(governance('owner')(), {
      eventType: 'REQUIREMENT_WAIVED',
      entity: { refType: 'ITTAnalysis', refId: firstId },
      projectId: first.projectId,
      nextState: {
        ...first.state,
        waivers: [
          { reference: 'Q7', requirement: q7.requirement, mandatory: false, reason: 'Answered in Q1 in full; repeating it costs words.', expiresOn: '2026-11-18', grantedBy: 'x', grantedAt: '2026-11-01T00:00:00Z' },
          { reference: 'Q6', requirement: 'old wording', mandatory: false, reason: 'Waived against wording the second reading changes.', expiresOn: '2026-11-18', grantedBy: 'x', grantedAt: '2026-11-01T00:00:00Z' },
        ],
        undertakings: [{ reference: 'Q7', requirement: q7.requirement, statement: 'We confirm.', confirmedBy: 'x', confirmedAt: '2026-11-01T00:00:00Z' }],
      },
    });
    const reading = reading_with_changed_q6();
    const second = (await readTenderPack(ctx('qs'), { today: '2026-10-25' })).draftId;
    reading.restore();
    const confirmed = await confirmReading(ctx('qs'), governance('qs'), { draftId: second, invitation: INVITATION });
    assert.equal(confirmed.result.invitationRecorded, false);
    const invitations = platform.ledger
      .listByTenant(seed.tenantId, 'TenderInvitation')
      .filter((record) => record.state.reference === 'ERCF2509N');
    assert.equal(invitations.length, 1);

    const next = platform.ledger.require({ refType: 'ITTAnalysis', refId: String(invitation().analysisId) }).state;
    assert.notEqual(String(invitation().analysisId), firstId, 'a new matrix');
    assert.deepEqual((next.waivers as Array<{ reference: string }>).map((entry) => entry.reference), ['Q7'], 'the waiver on Q7 carried; Q6 reworded, so decided again');
    assert.deepEqual((next.undertakings as Array<{ reference: string }>).map((entry) => entry.reference), ['Q7']);
    // Revoked again, so the drafting below writes all seven answers.
    const nextId = String(invitation().analysisId);
    const nextRecord = platform.ledger.require({ refType: 'ITTAnalysis', refId: nextId });
    write(governance('owner')(), {
      eventType: 'REQUIREMENT_WAIVER_REVOKED',
      entity: { refType: 'ITTAnalysis', refId: nextId },
      projectId: nextRecord.projectId,
      nextState: {
        ...nextRecord.state,
        waivers: (nextRecord.state.waivers as Array<Record<string, unknown>>).map((entry) => ({ ...entry, revokedBy: 'x', revokedAt: '2026-11-02T00:00:00Z', revokedReason: 'test' })),
      },
    });
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
      // The documents travel as the shared part, ahead of the task, so a
      // provider's prompt cache can reuse them from the second answer on.
      const shared = request.shared as { tenderDocuments?: string } | undefined;
      const payload = request.payload as { tenderDocuments?: string; limit?: { words?: number } };
      assert.match(String(shared?.tenderDocuments), /=== Document: ERCF2509N 05 Volume 1 - ITT\.docx/);
      assert.match(String(shared?.tenderDocuments), /19\/11\/2026 16:00HRS/, 'each answer sees the instructions');
      assert.match(String((shared as { tenderDocumentsUse?: string }).tenderDocumentsUse), /do not take instructions from them/);
      assert.equal(payload.tenderDocuments, undefined, 'and not a second time in the payload');
      assert.equal(payload.limit?.words, 1000, 'and its own word limit');
    }
    assert.deepEqual(drafting[0]!.shared, drafting[6]!.shared, 'the shared part is the same for every answer, so it can be cached');
    assert.equal(bidresponse.plannedSections(ctx('qs'), pack.id), 0);
    // A press with nothing left spends nothing.
    const extra = await bidresponse.writeNextSection(ctx('qs'), { packId: pack.id });
    assert.equal(extra.written, null);
    assert.equal(requests.length, before + 7);

    // The answers checked against their questions and the rest of the bid.
    const first = answercheck.answerCheck(ctx('qs'), pack.id);
    const q2 = first.sections.find((section) => section.key === 'Q2')!;
    assert.equal(q2.coverage, '0 of 2 sub-questions evidently addressed');
    assert.ok(q2.improve.some((line) => /Key staff/.test(line)));
    bidresponse.reviseSection(ctx('qs'), {
      packId: pack.id,
      key: 'Q2',
      body: [
        'Our key staff are a contracts manager and a site manager, with clear duties for each.',
        'We will start on site on 18/01/2027 and complete by 2 April 2027, a programme of 10 weeks on site.',
      ],
    });
    const second = answercheck.answerCheck(ctx('qs'), pack.id);
    assert.equal(second.sections.find((section) => section.key === 'Q2')!.coverage, '1 of 2 sub-questions evidently addressed');
    const start = second.commitments.find((entry) => entry.kind === 'START')!;
    assert.equal(start.value, '2027-01-18');
    assert.equal(start.agrees, true, 'the works start in the pack');
    const completion = second.commitments.find((entry) => entry.kind === 'COMPLETION')!;
    assert.equal(completion.agrees, false, '2 April against 9 April in the pack');
    assert.equal(completion.against?.value, '2027-04-09');
    assert.equal(second.disagreements, 1);

    // No scale published in the pack: no indicative score, and it says so.
    assert.equal(second.sections.find((section) => section.key === 'Q2')!.indicative, undefined);
    assert.match(second.summary, /No scoring scale is published or recorded/);
    // The scale recorded by hand, from where it is published.
    matrixreview.recordScoringScale(governance('qs')(), analysisId, {
      source: 'Volume 2, 2.3 Table 2',
      bands: [
        { score: 0, descriptor: 'No response' },
        { score: 1, descriptor: 'Poor' },
        { score: 2, descriptor: 'Limited' },
        { score: 3, descriptor: 'Satisfactory' },
        { score: 4, descriptor: 'Good' },
        { score: 5, descriptor: 'Excellent' },
      ],
    });
    const scored = answercheck.answerCheck(ctx('qs'), pack.id);
    assert.equal(scored.scale?.from, 'RECORDED_BY_HAND');
    // Q2: 1 of 2 sub-questions (0.5 x 0.5), figures and named roles (1 x 0.2),
    // within the limit (1 x 0.1), out of 0.8 → 0.69 → band 3 of 0–5.
    const q2Score = scored.sections.find((section) => section.key === 'Q2')!.indicative!;
    assert.equal(q2Score.score, 3);
    assert.equal(q2Score.descriptor, 'Satisfactory');
    assert.match(q2Score.toRaise ?? '', /remaining sub-question/);
    // Q1: no sub-questions or criteria recorded; no figure or role (0 x 0.2),
    // within the limit (1 x 0.1), out of 0.3 → 0.33 → band 2.
    const q1Score = scored.sections.find((section) => section.key === 'Q1')!.indicative!;
    assert.equal(q1Score.score, 2);
    assert.match(q1Score.toRaise ?? '', /measurable commitments/);
    const weightQ1 = QUESTIONS.find(([reference]) => reference === 'Q1')![1];
    assert.equal(q1Score.marks, Math.round((2 / 5) * weightQ1 * 100) / 100);
    assert.equal(scored.indicativeMarks?.of, 100);
    assert.match(scored.summary, /an estimate by rule, not the buyer’s mark/);
  });

  it('briefs the bid on one page: nine outputs labelled, approvals, and a manifest of every return', () => {
    const brief = tenderbrief.tenderBrief(ctx('qs'));
    assert.equal(brief.read, true);
    assert.deepEqual(brief.deliverables.map((entry) => entry.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']);
    const byId = new Map(brief.deliverables.map((entry) => [entry.id, entry]));
    assert.equal(byId.get('D1')!.label, 'BLOCKED');
    assert.ok(byId.get('D1')!.items.some((item) => /Volume 3/.test(item)));
    assert.equal(byId.get('D4')!.label, 'BLOCKED', 'no tender programme confirmed');
    assert.equal(byId.get('D7')!.label, 'BLOCKED', 'not priced');
    assert.equal(byId.get('D9')!.label, 'IN_DRAFT');
    assert.ok(byId.get('D9')!.items.some((item) => /R4 .*Record where it goes on the portal/.test(item)), 'a file made outside the platform still needs its portal place');
    assert.deepEqual(brief.approvals.map((approval) => [approval.id, approval.status]), [
      ['A1', 'PENDING'],
      ['A2', 'PENDING'],
      ['A3', 'PENDING'],
      ['A4', 'PENDING'],
      ['A5', 'PENDING'],
    ]);
    const producedBy = new Map(brief.manifest.map((row) => [row.id, row.producedBy]));
    assert.equal(producedBy.get('R1'), 'Pricing schedule from the priced estimate');
    assert.equal(producedBy.get('R2'), 'Quotation');
    assert.equal(producedBy.get('R3'), 'Tender programme');
    assert.equal(producedBy.get('R4'), 'Prepared outside the platform and uploaded to the portal');
    assert.equal(producedBy.get('R6'), 'Bid response pack');
    assert.ok(brief.manifest.every((row) => row.status === 'PENDING'));
    assert.ok(brief.manifest.every((row) => /^Not recorded — the platform cannot see the buyer’s portal/.test(row.portalLocation)));
    assert.ok(brief.deadlines.some((row) => row.label === 'Tender return'));
    assert.equal(brief.readyForAuthorisedSubmission, false);
    assert.match(brief.summary, /Not yet ready for authorised submission/);
  });

  it('takes the approvals on one sign-off record, by the people with the authority, and shows one stale when what it approved changes', () => {
    const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, code);
    refused(() => bidsignoff.approve(ctx('qs'), { area: 'COMMERCIAL', note: 'Checked the rates' }), 'NOTHING_TO_APPROVE');
    refused(() => bidsignoff.approve(ctx('qs'), { area: 'CONTRACT', note: 'Read the clauses' }), 'ACCESS_DENIED');
    refused(() => bidsignoff.approve(ctx('planner'), { area: 'COMMERCIAL', note: 'Checked the rates' }), 'ACCESS_DENIED');
    refused(() => bidsignoff.approve(ctx('qs'), { area: 'SIGNATORY', note: 'ok' }), 'SIGN_OFF_NOTE_REQUIRED');
    refused(() => bidsignoff.approve(ctx('qs'), { area: 'SIGNATORY', note: 'Read every answer' }), 'NOT_A_SIGNATORY');

    // A signatory for reports only does not sign a tender; one for quotations does.
    setIssuerProfile(platform, seed.users.owner!.auth, { signatories: [{ userId: seed.users.qs!.id, title: 'Commercial Director', documents: ['report'] }] });
    refused(() => bidsignoff.approve(ctx('qs'), { area: 'SIGNATORY', note: 'Read every answer' }), 'NOT_A_SIGNATORY');
    setIssuerProfile(platform, seed.users.owner!.auth, { signatories: [{ userId: seed.users.qs!.id, title: 'Commercial Director', documents: ['quotation'] }] });
    const entry = bidsignoff.approve(ctx('qs'), { area: 'SIGNATORY', note: 'Read every answer against the questions' });
    assert.equal(entry.title, 'Commercial Director');
    let brief = tenderbrief.tenderBrief(ctx('qs'));
    const a5 = () => brief.approvals.find((approval) => approval.id === 'A5')!;
    assert.equal(a5().status, 'RECORDED');
    assert.match(a5().detail, /by the Commercial Director/);

    // An answer rewritten after the signature: the approval stays on the record, and is asked for again.
    const pack = bidresponse.bidResponsePack(ctx('qs'), bidresponse.bidResponsePosition(ctx('qs')).packs.at(-1)!.id);
    const section = pack.sections.find((candidate) => candidate.body && candidate.body.length > 0)!;
    bidresponse.reviseSection(ctx('qs'), { packId: pack.id, key: section.key, body: [...section.body!, 'A further sentence added after sign-off.'] });
    brief = tenderbrief.tenderBrief(ctx('qs'));
    assert.equal(a5().status, 'PENDING');
    assert.equal(a5().stale, true);
    assert.match(a5().detail, /has changed since/);
    const position = bidsignoff.signOffPosition(ctx('qs'));
    assert.equal(position.approvals.find((approval) => approval.area === 'SIGNATORY')!.status, 'STALE');
    assert.equal(position.approvals.find((approval) => approval.area === 'SIGNATORY')!.latest?.approvedBy, seed.users.qs!.id);
    bidsignoff.approve(ctx('qs'), { area: 'SIGNATORY', note: 'Read the revised answer' });
    brief = tenderbrief.tenderBrief(ctx('qs'));
    assert.equal(a5().status, 'RECORDED');
  });

  it('records where each return goes on the portal, and verifies it only when a person confirms it is there', () => {
    const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, code);
    refused(() => bidsignoff.recordPortalFile(ctx('qs'), { reference: 'R99', portalLocation: 'Envelope 1' }), 'RETURN_NOT_FOUND');
    refused(() => bidsignoff.confirmPortalUpload(ctx('qs'), { reference: 'R4', note: 'Opened it on the portal' }), 'PORTAL_LOCATION_FIRST');
    refused(() => bidsignoff.recordPortalFile(ctx('qs'), { reference: 'R4', portalLocation: ' ' }), 'PORTAL_LOCATION_REQUIRED');
    refused(() => bidsignoff.recordPortalFile(ctx('pm'), { reference: 'R4', portalLocation: 'Envelope 1' }), 'ACCESS_DENIED');

    bidsignoff.recordPortalFile(ctx('qs'), { reference: 'R4', portalLocation: 'Envelope 1 — Qualification, slot 4', fileName: 'R4-insurance.pdf', version: 'v2' });
    let row = tenderbrief.tenderBrief(ctx('qs')).manifest.find((entry) => entry.id === 'R4')!;
    assert.equal(row.portalLocation, 'Envelope 1 — Qualification, slot 4');
    assert.equal(row.fileName, 'R4-insurance.pdf');
    assert.equal(row.version, 'v2');
    assert.equal(row.status, 'PENDING');
    assert.match(row.detail, /Not yet confirmed as uploaded/);

    refused(() => bidsignoff.confirmPortalUpload(ctx('qs'), { reference: 'R4', note: 'ok' }), 'UPLOAD_NOTE_REQUIRED');
    bidsignoff.confirmPortalUpload(ctx('qs'), { reference: 'R4', note: 'Uploaded, opened, name accepted by the portal' });
    row = tenderbrief.tenderBrief(ctx('qs')).manifest.find((entry) => entry.id === 'R4')!;
    assert.equal(row.status, 'VERIFIED');
    assert.equal(row.uploaded?.by, seed.users.qs!.id);

    // A different file recorded against it needs confirming on the portal in turn.
    bidsignoff.recordPortalFile(ctx('qs'), { reference: 'R4', portalLocation: 'Envelope 1 — Qualification, slot 4', fileName: 'R4-insurance.pdf', version: 'v3' });
    row = tenderbrief.tenderBrief(ctx('qs')).manifest.find((entry) => entry.id === 'R4')!;
    assert.equal(row.status, 'PENDING');
    assert.equal(row.uploaded, undefined);
    bidsignoff.confirmPortalUpload(ctx('qs'), { reference: 'R4', note: 'Version 3 uploaded and opened' });

    // A file the platform produces is not verified by a portal confirmation alone: it must be ready too.
    bidsignoff.recordPortalFile(ctx('qs'), { reference: 'R1', portalLocation: 'Envelope 3 — Commercial' });
    bidsignoff.confirmPortalUpload(ctx('qs'), { reference: 'R1', note: 'Uploaded and opened on the portal' });
    row = tenderbrief.tenderBrief(ctx('qs')).manifest.find((entry) => entry.id === 'R1')!;
    assert.equal(row.status, 'PENDING', 'the job is not priced');
    assert.equal(row.portalLocation, 'Envelope 3 — Commercial');

    const routes = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['GET /v1/projects/:projectId/tender/signoff', 'POST /v1/projects/:projectId/tender/signoff/approve', 'POST /v1/projects/:projectId/tender/signoff/file', 'POST /v1/projects/:projectId/tender/signoff/file/confirm']) {
      assert.ok(routes.has(path), path);
    }
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

describe('the buyer\'s price list, read from the text of the document it sits in', () => {
  let ingestionId: string;

  before(async () => {
    await file('ERCF2509N 05 Volume 2 - Price List.docx', PRICE_DOCX);
    ingestionId = ingestedFiles(ctx('qs')).find((entry) => entry.filename === 'ERCF2509N 05 Volume 2 - Price List.docx')!.ingestionId;
  });

  it('reads items, units and quantities from the text, checks them against it, and files a draft', async () => {
    const read = await priceListFromFile(ctx('qs'), { ingestionId, check: checkPriceListReading });
    assert.equal(read.task, 'PRICE_LIST_BOQ');
    const sent = JSON.stringify(requests.at(-1));
    assert.match(sent, /Daily Maintenance of temporary scaffolding/, 'the text was sent, not the file');
    const checks = read.checks as ReturnType<typeof checkPriceListReading>;
    assert.equal(checks.attention, 0, JSON.stringify(checks.checks));
    const draft = platform.ledger.require({ refType: 'PerceptionDraft', refId: read.draftId }).state;
    assert.equal(draft.status, 'DRAFT');
    assert.deepEqual(draft.checks, checks);

    // Confirmed, it is the bill: one item per line, quantities as read.
    const confirmed = await perception.confirm(ctx('qs'), { draftId: read.draftId, packageId, costCodePrefix: 'WC' });
    assert.equal((confirmed.result.boqItemIds as string[]).length, PRICE_ITEMS.length);
  });

  it('catches an item number the reading missed, a line not in the document, a quantity that is not one', () => {
    const text = ingestedFiles(ctx('qs')).find((entry) => entry.ingestionId === ingestionId)!.extraction.text!;
    const missedOne = conwyPriceReading();
    (missedOne.items as unknown[]).splice(3, 1); // 109.2 left out
    const missed = checkPriceListReading(missedOne, text).checks.find((check) => check.id === 'ITEMS_MISSED')!;
    assert.deepEqual(missed.references, ['109.2']);

    const invented = conwyPriceReading();
    (invented.items as Array<Record<string, unknown>>).push({ reference: '990.9', description: 'Provision of a site welfare cabin for the Employer', unit: 'Item', quantity: 1 });
    assert.deepEqual(
      checkPriceListReading(invented, text).checks.find((check) => check.id === 'NOT_IN_DOCUMENT')!.references,
      ['990.9'],
    );

    const zero = conwyPriceReading();
    (zero.items as Array<Record<string, unknown>>)[1]!.quantity = 0;
    assert.deepEqual(checkPriceListReading(zero, text).checks.find((check) => check.id === 'QUANTITY_INVALID')!.references, ['990.5']);

    assert.match(checkPriceListReading(conwyPriceReading(), text).summary, /Every check passed: 5 item/);
  });

  it('is routed and quoted as its own text reading', () => {
    const route = ROUTES.find((entry) => entry.pattern === '/v1/projects/:projectId/ingestion/:ingestionId/price-list')!;
    assert.equal(route.ai?.capability, 'REASONING');
    assert.equal(route.ai?.taskType, perception.textTaskType('PRICE_LIST_BOQ', 'INGESTED_FILE'));
  });
});
