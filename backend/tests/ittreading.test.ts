import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import * as business from '../src/domain/business.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import * as perception from '../src/engines/perception.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reading the invitation to tender.
 *
 * `analyseITT` could produce a compliance matrix, a term assessment and a list
 * of clarifications for the buyer — from a requirement list handed to it as an
 * argument. So the platform could analyse an invitation it had never seen, and
 * somebody had to type ninety numbered clauses out of a PDF before any of it
 * ran. That is the half-day the bid team actually loses, and it is the half
 * where things get missed: the requirement nobody typed is the requirement
 * nobody answers, and it surfaces at the evaluation as a non-compliance.
 *
 * The reading is a perception task rather than a new command, which fixes the
 * boundary in the right place:
 *
 *   - the model **reads**; whether the business can meet a requirement stays
 *     with `analyseITT` and the company profile, and whether to chase the job
 *     stays with the bid/no-bid algorithm;
 *   - what the document does not state is **not invented** — an ITT names its
 *     return date, not what this business expects to price the job at;
 *   - a reading is a **draft**, and confirming it runs the same commands, with
 *     the same authorisation, that a person typing the clauses would have run.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let projectId: string;
let invitationId: string;
let lastRequest: ProviderRequest | undefined;

/** A provider that can be handed a file, as a real one can. */
function multimodalStub(output: Record<string, unknown>): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      lastRequest = request;
      return { provider: 'GEMINI', modelClass: 'perception-standard', output, rawCostMinor: 40, latencyMs: 8, confidence: 0.9 };
    },
  };
}

/** What a bid manager would recognise coming back off a real ITT. */
const ITT_READING = {
  reference: 'YW/2026/SPILLWAY/014',
  clientName: 'Yorkshire Water Services Limited',
  returnBy: '2026-11-20',
  requirements: [
    {
      reference: 'SQ 4.1',
      category: 'INSURANCE',
      requirement: 'Employer’s liability insurance of not less than £10,000,000 per occurrence.',
      mandatory: true,
      evidenceRequired: 'Certificate of insurance, current at the return date',
    },
    {
      reference: 'SQ 6.2',
      category: 'HEALTH_AND_SAFETY',
      requirement: 'A three-year accident frequency rate below 0.35 per 100,000 hours worked.',
      mandatory: true,
      evidenceRequired: 'RIDDOR returns and hours worked, three years',
    },
    {
      reference: 'AW 2.4',
      category: 'SOCIAL_VALUE',
      requirement: 'Local employment and skills plan for the works duration.',
      mandatory: false,
      weightingPercent: 10,
      evidenceRequired: 'Method statement, four sides maximum',
      dueBy: '2026-11-13',
    },
  ],
  deliverables: [
    {
      reference: 'RD-01',
      title: 'Completed pricing schedule',
      mandatory: true,
      format: 'Native spreadsheet',
      channel: 'PORTAL',
    },
    {
      reference: 'RD-02',
      title: 'Quality submission',
      mandatory: true,
      format: 'PDF',
      pageLimit: 40,
      channel: 'PORTAL',
    },
    {
      reference: 'RD-03',
      title: 'Parent company guarantee, executed',
      mandatory: true,
      signatureRequired: true,
      bondRequired: true,
      channel: 'PHYSICAL',
    },
  ],
  terms: {
    contractForm: 'NEC4 Option A with Z-clauses',
    liquidatedDamagesPerWeekMinor: 4_500_000,
    liquidatedDamagesCapPercent: 10,
    performanceBondPercent: 10,
    parentCompanyGuaranteeRequired: true,
    retentionPercent: 5,
    paymentDays: 60,
    designLiability: 'FITNESS_FOR_PURPOSE',
    sectionalCompletions: 2,
    other: ['Unlimited liability for consequential loss under Z12'],
  },
  omitted: ['The bond wording is referenced as Appendix H, which was not in the transmittal'],
};

const ITT_FILE = Buffer.from('PDF-ish bytes standing in for an invitation to tender', 'utf8');
const ITT_HASH = hashBytes(ITT_FILE);

/**
 * A project at TENDER, walked through the gates.
 *
 * `ESTIMATE_TENDER` writes are gated to the tender phase, so a fixture that set
 * the phase by hand would be testing around the gate rather than through it.
 */
async function buildFixture(adapter?: AIProviderAdapter): Promise<void> {
  platform = new Platform(adapter ? new AIOrchestrator({ perception: adapter }) : undefined, store);
  seed = await seedDemoProject(platform);

  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  const created = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
    portfolioId,
    name: 'ITT reading fixture',
    sectorType: 'UTILITIES',
    assetType: 'Impounding reservoir',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Halifax' },
    contractValueMinor: 940_000_000,
    currency: 'GBP',
    plannedStart: '2027-01-11',
    plannedCompletion: '2029-06-29',
  });
  projectId = created.projectId;

  const pm = platform.context(seed.users.pm!.auth, projectId);
  const { packageId } = structure.createScopePackage(pm, {
    name: 'Spillway works',
    discipline: 'CIVILS',
    scopeOfWorks: 'Reconstruction of the auxiliary spillway and embankment crest raising.',
    inclusions: ['Embankment earthworks'],
    exclusions: ['Instrumentation supply'],
    acceptanceCriteria: ['Panel engineer sign-off'],
    estimatedValueMinor: 640_000_000,
    designResponsibility: 'CONTRACTOR',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined' });
  structure.assessDesignMaturity(pm, {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 82, frozen: true }],
    informationGaps: ['Draw-off tower survey outstanding'],
    assessorNotes: 'Civils priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'TENDER', justification: 'Priceable' });

  // The opportunity and the invitation the reading is filed against. An ITT is
  // read *into* an invitation the business has already recorded receiving —
  // there is no path where a document creates its own tender.
  const qs = platform.context(seed.users.qs!.auth, projectId);
  const { opportunityId } = business.registerOpportunity(qs, {
    title: 'Calderdale spillway reconstruction',
    clientName: 'Yorkshire Water Services Limited',
    sectorType: 'UTILITIES',
    estimatedValueMinor: 640_000_000,
    source: 'Utilities framework, lot 3',
    submissionDueAt: '2026-11-20',
  });
  invitationId = tenderintake.recordInvitation(qs, opportunityId, {
    reference: 'YW/2026/SPILLWAY/014',
    issuedAt: '2026-10-02T09:00:00Z',
    returnLocal: '2026-11-20T12:00',
    timeZone: 'Europe/London',
    timeZoneStated: true,
    channel: 'PORTAL',
    documents: ['Instructions to tenderers', 'Pricing schedule', 'Drawings pack C-1000 series'],
  }).invitationId;
}

const ctx = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId, { correlationId: 'itt-test' });

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-itt-'));
  store = new EvidenceStore(directory);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the invitation is read rather than typed', () => {
  before(async () => {
    await buildFixture(multimodalStub(ITT_READING));
    registerEvidenceFor(ctx('qs'), ITT_HASH, 'TENDER_DOCUMENT');
    await store.put(seed.tenantId, ITT_HASH, ITT_FILE, 'application/pdf');
  });

  it('sends the invitation to the provider as media, not stringified into the prompt', async () => {
    await perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' });

    assert.ok(lastRequest?.media, 'the file was not sent as media');
    assert.equal(lastRequest.media?.contentType, 'application/pdf');
    assert.ok(
      !JSON.stringify(lastRequest.payload).includes(ITT_FILE.toString('base64').slice(0, 24)),
      'the file was stringified into the payload, which is the same bytes at text rates read by nothing',
    );
  });

  it('produces a draft, and analyses nothing until somebody confirms it', async () => {
    const draft = await perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' });

    assert.ok(draft.draftId, 'no draft was written');
    assert.equal(
      platform.ledger.list(projectId, 'ITTAnalysis').length,
      0,
      'a reading produced a compliance matrix without anybody confirming it',
    );
  });

  it('turns a confirmed reading into the matrix, through the ordinary analyst', async () => {
    const draft = await perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' });
    const confirmed = await perception.confirm(ctx('qs'), {
      draftId: draft.draftId,
      invitationId,
      // Supplied by the person, because no invitation states them about the
      // bidder.
      estimatedValueMinor: 640_000_000,
      durationWeeks: 128,
    });

    const result = confirmed.result as {
      analysisId: string;
      requirements: number;
      deliverables: number;
      bars: string[];
      readyToPrice: boolean;
      quantifiedExposureMinor: number;
    };

    assert.equal(result.requirements, 3, 'the requirements the model read did not reach the matrix');
    assert.equal(result.deliverables, 3, 'the return deliverables did not reach the register');
    assert.ok(result.analysisId, 'no analysis was produced');

    // The terms the reading carried are assessed, not merely stored. Fitness
    // for purpose and unlimited consequential loss are the two that end bids.
    assert.ok(result.bars.length > 0, 'a fitness-for-purpose obligation was not raised as a bar');
    assert.equal(result.readyToPrice, false, 'an invitation with a bar in it was reported ready to price');
    assert.ok(result.quantifiedExposureMinor > 0, 'damages of £45,000 a week quantified to nothing');
  });

  it('binds the matrix to the invitation it was read from', async () => {
    const stored = platform.ledger.require({ refType: 'TenderInvitation', refId: invitationId }).state;
    assert.equal(stored.requirementsExtracted, true);
    assert.ok(stored.analysisId, 'the invitation does not name the analysis produced from it');
  });
});

describe('what the invitation does not say about the bidder', () => {
  before(async () => {
    await buildFixture(multimodalStub(ITT_READING));
    registerEvidenceFor(ctx('qs'), ITT_HASH, 'TENDER_DOCUMENT');
    await store.put(seed.tenantId, ITT_HASH, ITT_FILE, 'application/pdf');
  });

  it('refuses to confirm without the value and the duration', async () => {
    // An ITT names its return date and its contract form. It does not name what
    // this business expects to price the job at, and a model that produced one
    // would be inventing the number the whole bid turns on.
    const draft = await perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' });

    await assert.rejects(
      () => perception.confirm(ctx('qs'), { draftId: draft.draftId, invitationId }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PERCEPTION_TARGET_REQUIRED');
        return true;
      },
    );
  });
});

describe('a reading too thin to be worth confirming', () => {
  before(async () => {
    // An invitation with no requirements has not been read — the same guard
    // `analyseITT` applies, applied before anybody is shown a matrix.
    await buildFixture(multimodalStub({ reference: 'YW/2026/SPILLWAY/014', requirements: [] }));
    registerEvidenceFor(ctx('qs'), ITT_HASH, 'TENDER_DOCUMENT');
    await store.put(seed.tenantId, ITT_HASH, ITT_FILE, 'application/pdf');
  });

  it('refuses it rather than filing an empty matrix', async () => {
    await assert.rejects(() => perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' }));
  });
});

describe('a provider that cannot see the document', () => {
  before(async () => {
    // The deployment default. Refusing is a true statement about it; a
    // deterministic hash-derived requirement list would be a false statement
    // about the tender, filed as a governed record.
    await buildFixture();
    registerEvidenceFor(ctx('qs'), ITT_HASH, 'TENDER_DOCUMENT');
    await store.put(seed.tenantId, ITT_HASH, ITT_FILE, 'application/pdf');
  });

  it('is refused rather than asked anyway', async () => {
    await assert.rejects(
      () => perception.extract(ctx('qs'), store, { hash: ITT_HASH, task: 'ITT_REQUIREMENTS' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PERCEPTION_PROVIDER_UNAVAILABLE');
        return true;
      },
    );
  });
});

/** Evidence committed directly, as the perception fixture does. */
function registerEvidenceFor(ctx: EngineContext, hash: string, type: string): void {
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: {
      id: `ev-${hash.slice(-12)}`,
      type,
      hash,
      description: 'Registered by the ITT reading fixture',
      linkedEntities: [],
      capturedAt: new Date().toISOString(),
      capturedBy: ctx.auth.actorId,
    },
  });
}
