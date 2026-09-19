import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import * as structure from '../src/domain/structure.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The whole pricing line, over HTTP, in one run: drawings in, numbered
 * quotation out.
 *
 * This file exists because of a specific and repeated failure, and it is worth
 * writing down plainly. Every piece of this line had unit tests. Every one of
 * those tests passed. And the line was broken in production four separate
 * times in a day — because each unit test stubbed exactly the thing that was
 * broken:
 *
 * - the console read `file.kind` and the register published
 *   `classification.kind`, so a pack of drawings showed as nought drawings.
 *   The pipeline test asserted the pipeline's own return value, which was
 *   right, and never asserted what the API published.
 * - three route schemas refused fields their own engines require. Every engine
 *   test called the engine directly, so no test ever went through a schema.
 * - the market-rate join matched on the description text, and a real model
 *   paraphrases what it is shown, so every line was dropped. The stub echoed
 *   the description back verbatim.
 * - a document label is capped at eighty characters and an NRM2 description is
 *   routinely longer, so the quotation was refused. The fixture's descriptions
 *   were short.
 *
 * The common shape: **the unit was correct and the join between units was
 * not.** No amount of further unit testing finds that. So this drives the
 * product the way a customer does — over the wire, through the schemas, with
 * providers that behave like real models rather than like fixtures — and
 * asserts on what came out at the far end.
 *
 * The rules this holds the stubs to, each one taken from a failure above:
 *
 * - **the model paraphrases.** Nothing it returns is echoed back verbatim, so
 *   any join that matches on text fails here rather than in front of a
 *   customer.
 * - **the model answers in the shape it feels like.** One sheet comes back
 *   with `items`, the other with `lines`; one rate is split four ways and
 *   another is a single all-in figure.
 * - **the model does not answer everything.** It takes a view on some lines
 *   and stays silent on the rest, which is what leaves work for a person.
 * - **the descriptions are real length.** The longest is 108 characters, which
 *   is the one that broke the quotation.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;
let packageId: string;

type Reply = { status: number; body: any; text: string };

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; raw?: Buffer; contentType?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let payload: Buffer | string | undefined;
  if (options.raw) {
    payload = options.raw;
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

/** Sign in the way a person does: login, then answer the challenge. */
async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', { body: { email } });
  assert.equal(login.status, 201, login.text);
  const verified = await call('POST', '/v1/auth/mfa/verify', {
    body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
  });
  assert.equal(verified.status, 201, verified.text);
  return verified.body.accessToken as string;
}

/**
 * Three sheets of a real job, and what a model reports off each.
 *
 * The descriptions are NRM2-length on purpose. The first is 108 characters —
 * it is the item that met `DOCUMENT_BODY_INVALID` on the first real bill,
 * because the quotation used the description as the row label and a label
 * holds eighty. Shortening it here would have hidden the defect again.
 */
const SHEETS = [
  {
    filename: '25133-TDC-FN-ZZ-DR-S-1600.pdf',
    drawingNumber: '25133-TDC-FN-ZZ-DR-S-1600',
    bytes: Buffer.from('%PDF-1.7 foundation general arrangement', 'utf8'),
    /** Answers in `items`, the documented shape. */
    shape: 'items' as const,
    items: [
      {
        description:
          'Excavation for two number pad foundations, commencing from existing ground level, maximum depth not exceeding 2.00m',
        unit: 'm3',
        quantity: 46,
        sourceSheet: 'DR-S-1600',
        measurementRule: 'NRM2',
      },
      {
        description: 'Disposal of excavated material off site to a licensed tip, including all tipping charges',
        unit: 'm3',
        quantity: 46,
        sourceSheet: 'DR-S-1600',
        measurementRule: 'NRM2',
      },
    ],
  },
  {
    filename: '25133-TDC-FN-ZZ-DR-S-1601.pdf',
    drawingNumber: '25133-TDC-FN-ZZ-DR-S-1601',
    bytes: Buffer.from('%PDF-1.7 reinforcement details', 'utf8'),
    /** Answers in `lines`, which is what half of them do. */
    shape: 'lines' as const,
    items: [
      {
        description: 'Reinforcement bars, grade B500B, 16mm diameter, bent and fixed in foundations',
        unit: 'tonne',
        quantity: 2.4,
        sourceSheet: 'DR-S-1601',
        measurementRule: 'NRM2',
      },
    ],
  },
  {
    filename: '25133-TDC-FN-ZZ-DR-S-1602.pdf',
    drawingNumber: '25133-TDC-FN-ZZ-DR-S-1602',
    bytes: Buffer.from('%PDF-1.7 blinding and formwork', 'utf8'),
    shape: 'items' as const,
    items: [
      {
        description: 'Plain in-situ concrete blinding, 50mm thick, poured against earth faces',
        unit: 'm2',
        quantity: 38,
        sourceSheet: 'DR-S-1602',
        measurementRule: 'NRM2',
      },
    ],
  },
];

/** Every request each stub was handed, so the test can assert what was asked. */
let seenRequests: ProviderRequest[] = [];
let marketRequests: ProviderRequest[] = [];

/**
 * A perception provider that answers about the sheet it was actually given.
 *
 * Keyed on the media hash rather than on call order: a stub that answers the
 * same thing whatever it is shown passes a test in which the run reads one
 * drawing three times, which is a failure this file exists to catch.
 */
function seeingStub(): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      seenRequests.push(request);
      const sheet = SHEETS.find((candidate) => request.media?.hash === hashBytes(candidate.bytes));
      const items = sheet?.items ?? [];
      return {
        provider: 'GEMINI',
        modelClass: 'perception-standard',
        // Two shapes from one provider, which is what a model does across
        // calls. The reader has to take either or the pack is half-measured.
        output: sheet?.shape === 'lines' ? { lines: items, omitted: [] } : { items, omitted: [], scale: '1:50' },
        rawCostMinor: 40,
        latencyMs: 9,
        confidence: 0.86,
      };
    },
  };
}

/**
 * A reasoning provider with a partial view of the market.
 *
 * It answers about reinforcement and blinding and says nothing about the
 * excavation or the disposal, and it rewords everything it answers. Both are
 * deliberate: a model that fills every row is the failure mode, and a join
 * that matches on the words it was given matches nothing at all.
 */
function reasoningStub(): AIProviderAdapter {
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: true,
    estimateCostMinor: () => 30,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      marketRequests.push(request);
      const items =
        (request.payload as { items?: Array<{ index: number; description: string; unit: string }> } | undefined)?.items ??
        [];
      const rates = items.flatMap((item): Array<Record<string, unknown>> => {
        if (item.description.startsWith('Reinforcement bars')) {
          return [
            {
              index: item.index,
              // Reworded. Nothing here is the string it was handed.
              description: 'Rebar supply, cut, bend and fix — B500B',
              unit: item.unit,
              labourMinor: 42_000_00,
              materialMinor: 98_000_00,
              plantMinor: 0,
              subcontractMinor: 0,
              lowMinor: 125_000_00,
              highMinor: 155_000_00,
              basis: 'Merchant price for B500B plus a two-man fixing gang at north-west day rates.',
            },
          ];
        }
        if (item.description.startsWith('Plain in-situ concrete blinding')) {
          return [
            {
              index: item.index,
              description: 'Blinding layer, 50mm, ready-mix',
              unit: item.unit,
              // A single all-in figure with no split, which is the commoner
              // answer. It has to land as direct works and say so.
              rateMinor: 2_150,
              lowMinor: 1_900,
              highMinor: 2_600,
              basis: 'Ready-mix GEN1 delivered, placed by hand.',
            },
          ];
        }
        return [];
      });
      return {
        provider: 'OPENAI',
        modelClass: 'reasoning-standard',
        output: { rates, omitted: [] },
        rawCostMinor: 30,
        latencyMs: 7,
      };
    },
  };
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-pricingline-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ perception: seeingStub(), reasoning: reasoningStub() }), store);
  seed = await seedDemoProject(platform);

  // Setup is setup: the project is stood up through the domain, because none
  // of it is what this file is testing. Everything from the first upload
  // onwards goes over the wire.
  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  projectId = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`, { source: 'WEB' }), {
    portfolioId,
    name: 'Bolton Road pumping station — foundations',
    sectorType: 'UTILITIES',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
    contractValueMinor: 40_000_00,
    currency: 'GBP',
    plannedStart: '2026-10-05',
    plannedCompletion: '2027-01-29',
  }).projectId;

  packageId = structure.createScopePackage(platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' }), {
    name: 'Foundations',
    discipline: 'CIVILS',
    scopeOfWorks: 'Excavate, blind, reinforce and cast two pad foundations.',
    inclusions: ['Excavation and disposal', 'Blinding', 'Reinforcement'],
    exclusions: ['Anything above the underside of the base slab'],
    acceptanceCriteria: ['Accepted on the engineer’s inspection of the reinforcement before pour'],
    estimatedValueMinor: 40_000_00,
    designResponsibility: 'CLIENT',
  }).packageId;

  structure.transitionPhase(platform.context(admin, projectId, { source: 'WEB' }), {
    to: 'DESIGN',
    justification: 'Scope defined',
  });
  structure.assessDesignMaturity(platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' }), {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 95, frozen: true }],
    informationGaps: [],
    assessorNotes: 'The foundation details are issued and priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Pricing the foundations',
  });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server?.close();
  rmSync(directory, { recursive: true, force: true });
});

// What the run produced, carried between the steps of the one journey below.
let qsToken = '';
let adminToken = '';
let bimToken = '';
let proposal: any;
let accepted: any;

describe('the pricing line, end to end over HTTP', () => {
  it('signs the three seats in that a priced job actually passes through', async () => {
    /*
     * Three people, because the platform says so and it is right to.
     *
     * Filing a drawing is a design-information act and no role of QS holds
     * `I` on DESIGN_INFORMATION; approving a quotation is not done by the
     * person who priced it. A test that drove all of it as one omnipotent user
     * would pass while the product was unusable by a real team — which is the
     * failure mode this file exists for. On a sole-operator account the owner
     * holds all three, and holds them because OWNER holds every code in every
     * tenant area, not because any of these checks is loosened.
     */
    bimToken = await signIn('bim@meridian.example');
    qsToken = await signIn('qs@meridian.example');
    adminToken = await signIn('amara.osei@meridian.example');
    for (const token of [bimToken, qsToken, adminToken]) assert.ok(token.length > 20);
  });

  it('takes three drawings in: registered, uploaded, ingested', async () => {
    for (const sheet of SHEETS) {
      const hash = hashBytes(sheet.bytes);

      // Registering the drawing is what claims the hash as evidence. Bytes
      // may only be supplied against a hash the ledger already names, which
      // is the rule that stops this being an open blob store.
      const registered = await call('POST', `/v1/projects/${projectId}/bim/drawings`, {
        token: bimToken,
        body: {
          fileHash: hash,
          titleBlock: {
            drawingNumber: sheet.drawingNumber,
            title: 'Foundation details',
            revision: 'P02',
            discipline: 'STRUCTURES',
          },
        },
      });
      assert.equal(registered.status, 201, registered.text);

      const uploaded = await call('POST', `/v1/evidence/${hash}`, {
        token: bimToken,
        raw: sheet.bytes,
        contentType: 'application/pdf',
      });
      assert.equal(uploaded.status, 201, uploaded.text);

      const ingested = await call('POST', `/v1/projects/${projectId}/ingestion`, {
        token: bimToken,
        body: { hash, filename: sheet.filename },
      });
      assert.equal(ingested.status, 201, ingested.text);
    }
  });

  it('publishes them as drawings in the shape the console reads', async () => {
    /*
     * The exact defect that shipped, asserted at the boundary it shipped
     * through.
     *
     * The pipeline classified all three correctly and its own test proved it.
     * What the API published was `classification.kind`, and two screens read
     * `file.kind` — so the drawing row never rendered the one button that
     * measures a drawing, and the pack read as nought drawings filed. Nothing
     * threw. A button was simply absent.
     */
    const listed = await call('GET', `/v1/projects/${projectId}/ingestion`, { token: qsToken });
    assert.equal(listed.status, 200, listed.text);

    const files = listed.body.files as Array<Record<string, any>>;
    assert.equal(files.length, SHEETS.length, 'the register did not publish every filed drawing');
    for (const file of files) {
      assert.equal(
        file.classification?.kind,
        'DRAWING',
        `${file.filename} was published as ${file.classification?.kind ?? '(nothing)'}`,
      );
      assert.notEqual(file.status, 'QUARANTINED', `${file.filename} was quarantined`);
    }
  });

  it('tells the person which road this job is on and what to do next', async () => {
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token: qsToken });
    assert.equal(flow.status, 200, flow.text);
    assert.equal(flow.body.road, 'PRICE', 'a job with drawings and no invitation is a price, not a bid');
    assert.ok(typeof flow.body.why === 'string' && flow.body.why.length > 0, 'the road was not explained');
    assert.ok(Array.isArray(flow.body.steps) && flow.body.steps.length > 0, 'the flow named no steps');
    assert.ok(flow.body.nowDo, 'the flow named nothing to do next');

    /*
     * The invariant that matters, and the one that failed in front of the
     * person paying for this: **a step the platform says to do now must say
     * where the button is.** "Price the bill" was named as the next thing to
     * do on a screen that had no such control anywhere on it, and the only
     * possible response to that is to ask somebody — which a customer cannot.
     *
     * A blocked step is exempt, and deliberately: there is nothing to press
     * until whatever blocks it is done, and inventing a door for it would send
     * a person to a control that is not there.
     */
    for (const step of flow.body.steps as Array<Record<string, unknown>>) {
      if (step.state !== 'READY') continue;
      assert.ok(
        typeof step.door === 'string' && String(step.door).length > 0,
        `"${String(step.title)}" is ready to do and names no door: ${JSON.stringify(step)}`,
      );
      assert.ok(
        typeof step.screen === 'string' && String(step.screen).length > 0,
        `"${String(step.title)}" names a door on no screen`,
      );
    }

    const now = flow.body.nowDo as Record<string, unknown>;
    assert.equal(now.id, 'MEASURED', 'with three drawings filed and nothing measured, the next thing is to measure them');
    assert.equal(now.door, 'Read and price the pack');
    assert.equal(now.command, 'price-pack', 'the one thing to do next is not wired to a command the console can dispatch');
  });

  it('reads and measures the whole pack in one run, and prices what it can', async () => {
    const priced = await call('POST', `/v1/projects/${projectId}/tender/pack/price`, {
      token: qsToken,
      body: { packageId },
    });
    assert.equal(priced.status, 201, priced.text);
    proposal = priced.body;

    assert.equal(proposal.read.length, SHEETS.length, 'the run did not read every sheet');
    assert.equal(proposal.unread.length, 0, `a sheet went unread: ${JSON.stringify(proposal.unread)}`);

    // Every sheet read once, and each one actually looked at — not the same
    // one three times. The stub answers by media hash, so three distinct
    // hashes in the requests is the proof.
    const shown = new Set(seenRequests.map((request) => request.media?.hash).filter(Boolean));
    assert.equal(shown.size, SHEETS.length, 'the run did not show the model three different sheets');

    const expected = SHEETS.flatMap((sheet) => sheet.items);
    assert.equal(proposal.lines.length, expected.length, 'the run measured a different number of items than the sheets hold');
    for (const item of expected) {
      const found = (proposal.lines as Array<Record<string, any>>).find(
        (line) => line.description === item.description,
      );
      assert.ok(found, `"${item.description.slice(0, 40)}…" was measured off the sheet and is not in the run`);
      assert.equal(found.quantity, item.quantity);
      assert.equal(found.unit, item.unit);
    }
  });

  it('carries a model’s market view as a market view, whatever shape it arrived in', async () => {
    /*
     * The failure this replaces: the join matched the model's answer to the
     * question by description text. A real model rewords what it is shown, so
     * every rate it returned was dropped and the screen said the market had no
     * view of twenty-two lines it had just taken a view on.
     *
     * The stub rewords both of its answers and splits only one of them. Both
     * have to land.
     */
    assert.ok(marketRequests.length > 0, 'the run never asked the market anything');
    assert.ok(proposal.marketView, 'the run took no market view and did not say why');
    assert.equal(proposal.marketView.used, 2, `the market view was asked for 2 lines and used ${proposal.marketView.used}`);

    const byDescription = (text: string) =>
      (proposal.lines as Array<Record<string, any>>).find((line) => line.description.startsWith(text));

    const rebar = byDescription('Reinforcement bars');
    assert.ok(rebar?.rate, 'the split market rate was dropped');
    assert.equal(rebar.rate.source, 'MARKET_AI');
    assert.equal(rebar.rate.labourRateMinor, 42_000_00);
    assert.equal(rebar.rate.materialRateMinor, 98_000_00);

    const blinding = byDescription('Plain in-situ concrete blinding');
    assert.ok(blinding?.rate, 'the all-in market rate was dropped');
    assert.equal(blinding.rate.source, 'MARKET_AI');
    assert.equal(blinding.rate.allInMinor, 2_150, 'an unsplit rate did not survive as the rate it is');

    // And the lines nothing answered for stay unpriced and say so, rather
    // than arriving at nought — which is the answer that loses money.
    const excavation = byDescription('Excavation for two number pad foundations');
    assert.ok(excavation, 'the excavation line is not in the run at all');
    assert.equal(excavation.rate, null);
    assert.ok(
      typeof excavation.unpriced === 'string' && excavation.unpriced.length > 0,
      'an unpriced line said nothing about why',
    );
  });

  it('names the cost heads to settle before anything is accepted, not after', async () => {
    /*
     * A quotation refuses an estimate carrying a head that is neither priced
     * nor excluded, and that refusal is right. Meeting it *after* the bill has
     * been written and the estimate built is not: the person is told what was
     * needed at the point it is too late to give it without starting again.
     *
     * So the run computes the same omissions in advance and asks.
     */
    assert.ok(Array.isArray(proposal.headsToSettle), 'the run did not say which heads need an answer');
    assert.ok(proposal.headsToSettle.length > 0, 'a virgin estimate settled every head by itself, which cannot be right');
    for (const head of proposal.headsToSettle) {
      assert.ok(head.head && head.label, `a head to settle was unnamed: ${JSON.stringify(head)}`);
    }
    assert.ok(
      (proposal.outstanding as string[]).some((line) => line.includes('neither priced nor excluded')),
      'the heads to settle were computed and never said out loud',
    );
  });

  it('writes nothing until a person accepts', async () => {
    // The run reads and proposes. No bill, no estimate and no quotation may
    // exist until somebody decides — otherwise looking at a price is taking
    // one.
    const boq = await call('GET', `/v1/projects/${projectId}/tender/boq`, { token: qsToken });
    assert.equal(boq.status, 200, boq.text);
    assert.equal((boq.body.items ?? []).length, 0, 'the run wrote a bill nobody accepted');
  });

  it('accepts once: confirms every reading, writes the bill, prices it and draws the quotation', async () => {
    // Every head the run named, answered. Two are excluded and the rest are
    // priced, which is the decision a person actually takes on this screen.
    const basis = proposal.basis as Record<string, any> | null;
    const excluded = (proposal.headsToSettle as Array<{ head: string }>).map((entry) => ({
      head: entry.head,
      reason: 'Not in this offer for the foundations package',
    }));

    const lines = (proposal.lines as Array<Record<string, any>>).map((line) => ({
      draftId: line.draftId,
      index: line.index,
      // The rate the run proposed where it had one, and a rate of the person's
      // own where it did not. Both paths in one acceptance, because both
      // happen on a real job.
      ...(line.rate
        ? {
            labourRateMinor: line.rate.labourRateMinor,
            materialRateMinor: line.rate.materialRateMinor,
            plantRateMinor: line.rate.plantRateMinor,
            subcontractRateMinor: line.rate.subcontractRateMinor,
            rateSource: line.rate.source,
          }
        : { labourRateMinor: 4_500, materialRateMinor: 0, plantRateMinor: 3_200, subcontractRateMinor: 0, rateSource: 'PERSON' }),
    }));

    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const reply = await call('POST', `/v1/projects/${projectId}/tender/pack/accept`, {
      token: qsToken,
      body: {
        packageId,
        costCodePrefix: 'FND',
        lines,
        estimate: {
          durationWeeks: 6,
          basisOfEstimate:
            'Measured off drawings 1600, 1601 and 1602 at revision P02. Rates are our own where we hold them and a market view where we do not.',
          assumptions: ['Ground conditions as the site investigation reports them', 'Uninterrupted access during working hours'],
          // Everything the run inherited from this business's last complete
          // estimate, carried forward — exactly as the console's own form
          // carries it. The acceptance route cannot know the basis; it is the
          // person's to keep or change, so it comes back with the answer.
          //
          // Leaving it out is what made the pre-flight and the estimate
          // disagree the first time this ran, and the disagreement was the
          // test's fault rather than the product's. It is worth a comment: a
          // test that quietly drops a field the console sends is testing a
          // journey nobody takes.
          ...(basis?.timeRelated ? { timeRelated: basis.timeRelated } : {}),
          ...(basis?.quantified ? { quantified: basis.quantified } : {}),
          ...(basis?.insurance ? { insurance: basis.insurance } : {}),
          exclusions: [...(basis?.exclusions ?? []), ...excluded],
          margin: { overheadPercent: 9, profitPercent: 7 },
        },
        quotation: {
          clientName: 'Bolton Road Water Limited',
          validUntil,
          paymentTerms: '30 days from the date of a valid application',
          coveringNote: 'We are pleased to offer the following for the foundation works.',
        },
      },
    });
    assert.equal(reply.status, 201, reply.text);
    accepted = reply.body;

    /*
     * The heads the run named in advance were the heads the estimate needed.
     *
     * They were not, and the disagreement was total: the run said SUBCONTRACT,
     * PLANT and RISK; the estimate refused for PRELIMINARIES, INSURANCE, WASTE
     * and HEALTH_AND_SAFETY — four heads out of four that were never
     * mentioned. The band that decides which heads are expected was taken from
     * the works as priced, and at the moment the run computes it most lines
     * carry no rate at all, so the job bands a size too small. Typing the
     * rates in is what made the other four appear, which is to say the warning
     * changed under the person answering it.
     */
    assert.equal(
      accepted.quotationBlocked,
      null,
      `every head the run named was answered and the quotation was still refused: ${JSON.stringify(accepted.quotationBlocked)}`,
    );

    assert.equal(accepted.boqItemIds.length, proposal.lines.length, 'the bill does not hold every measured line');
    assert.ok(accepted.estimateId, 'no estimate was built');
    assert.ok(accepted.totalMinor > 0, 'the estimate priced at nothing');
    assert.ok(accepted.quotationId, 'the acceptance stopped short of the quotation');
    assert.equal(accepted.quotationNumberPending, true, 'a draft quotation was handed a number before it was issued');
  });

  it('measured the pack once, not once per acceptance', async () => {
    // Three sheets in, three bill items' worth of readings out. The bill
    // holding more than the sheets hold is the duplicate-measurement defect,
    // and it is only visible from outside the run.
    const boq = await call('GET', `/v1/projects/${projectId}/tender/boq`, { token: qsToken });
    assert.equal(boq.status, 200, boq.text);
    const expected = SHEETS.flatMap((sheet) => sheet.items).length;
    assert.equal(
      (boq.body.items ?? []).length,
      expected,
      `the bill holds ${(boq.body.items ?? []).length} items and the pack holds ${expected}`,
    );
  });

  it('writes a quotation whose rows are the works, and whose rows add up', async () => {
    const document = await call('GET', `/v1/documents/lifecycle/${accepted.quotationId}`, { token: qsToken });
    assert.equal(document.status, 200, document.text);

    const body = document.body.body as Record<string, string>;
    assert.ok(body, 'the quotation has no body');

    // Every measured item is offered, by its full description. A quotation
    // that shortens the description offers something else.
    for (const item of SHEETS.flatMap((sheet) => sheet.items)) {
      const row = Object.values(body).find((value) => typeof value === 'string' && value.includes(item.description));
      assert.ok(row, `the quotation does not offer "${item.description.slice(0, 40)}…"`);
    }

    // The rows add up to the total. A quotation whose lines do not sum to its
    // own total is the first thing a client's surveyor finds.
    const money = (text: string): number | null => {
      const match = /£\s?([\d,]+\.\d{2})/.exec(text);
      return match ? Math.round(Number(match[1]!.replace(/,/g, '')) * 100) : null;
    };
    const itemRows = Object.entries(body).filter(([label]) => /^Item \d+$/.test(label));
    assert.equal(itemRows.length, proposal.lines.length, 'the quotation does not carry one row per measured line');
    const summed = itemRows.reduce((total, [, value]) => total + (money(String(value)) ?? 0), 0);
    const stated = money(String(body['Total, excluding VAT'] ?? ''));
    assert.ok(stated, 'the quotation states no total');
    assert.equal(summed, stated, `the rows sum to ${summed} and the quotation states ${stated}`);
    assert.equal(stated, accepted.totalMinor, 'the quotation total is not the estimate total');

    // And the customer sees a price, not our build-up. No overhead, no
    // profit, no margin, no cost — anywhere in the document.
    const printed = JSON.stringify(body).toLowerCase();
    for (const word of ['overhead', 'profit', 'margin', 'markup']) {
      assert.ok(!printed.includes(word), `the quotation prints our "${word}" to the customer`);
    }
  });

  it('goes out as a numbered, approved instrument', async () => {
    // The company's registered details and its numbering rule, recorded over
    // the wire by the administrator who holds that authority.
    const profile = await call('PUT', '/v1/company/issuer', {
      token: adminToken,
      body: {
        issuer: {
          registrationNo: '08442119',
          registeredAddress: {
            line1: '14 Bury Road',
            line2: '',
            city: 'Rawtenstall',
            postcode: 'BB4 6AA',
            country: 'United Kingdom',
          },
        },
        // The prefix once. Writing it into the pattern as well — which is the
        // natural thing to do, and what the first fixture here did — numbered
        // the quotation QUOQUO-2026-0001 and nothing caught it, because the
        // test that issued one asserted only that *a* number came back.
        numberingRules: { quotation: { prefix: 'QUO-', pattern: '{YYYY}-{seq:4}', seqScope: 'year' } },
      },
    });
    assert.equal(profile.status, 200, profile.text);

    // And the mistake itself is refused where it is made, rather than turning
    // up on the front of a legal instrument that cannot be renumbered.
    const doubled = await call('PUT', '/v1/company/issuer', {
      token: adminToken,
      body: { numberingRules: { invoice: { prefix: 'INV', pattern: 'INV-{YYYY}-{seq:4}', seqScope: 'year' } } },
    });
    assert.equal(doubled.status, 422, doubled.text);
    assert.match(doubled.text, /NUMBERING_PREFIX_REPEATED/);
    assert.match(doubled.text, /INVINV-\d{4}-0001/, 'the refusal did not say what the number would have come out as');

    const generated = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/generate`, {
      token: qsToken,
      body: {},
    });
    assert.equal(generated.status, 201, generated.text);
    const revision = (generated.body.revisions as Array<{ hash: string }>).at(-1)!;

    const submitted = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/submit`, {
      token: qsToken,
      body: {},
    });
    assert.equal(submitted.status, 201, submitted.text);

    // The surveyor who priced it does not approve it.
    const selfApproved = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/approve`, {
      token: qsToken,
      body: { revision: generated.body.revisions.length, hash: revision.hash },
    });
    assert.ok(selfApproved.status >= 400, 'the person who priced the job approved their own quotation');

    const approved = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/approve`, {
      token: adminToken,
      body: { revision: generated.body.revisions.length, hash: revision.hash },
    });
    assert.equal(approved.status, 201, approved.text);

    const issued = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/issue`, {
      token: adminToken,
      body: { idempotencyKey: `pricing-line-${accepted.quotationId}` },
    });
    assert.equal(issued.status, 201, issued.text);
    assert.equal(issued.body.document.status, 'ISSUED');
    assert.match(String(issued.body.issuance.number), /^QUO-\d{4}-\d{4}$/, `the quotation went out as ${JSON.stringify(issued.body.issuance)}`);

    // Issuing again under the same key finishes the same issuance rather than
    // burning a second number on one offer.
    const again = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/issue`, {
      token: adminToken,
      body: { idempotencyKey: `pricing-line-${accepted.quotationId}` },
    });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.body.issuance.number, issued.body.issuance.number, 'a retry issued a second number');
  });

  it('leaves the market-priced lines out of this business’s own rate history', async () => {
    /*
     * The rule that keeps the record honest. A rate a model took a view on is
     * not a rate this business has committed, and harvesting it back as one
     * would launder a guess into evidence — every later job would then propose
     * it as "our own rate", and the guess would compound.
     */
    const rates = await call('GET', `/v1/company/rates`, { token: qsToken });
    if (rates.status === 404) return; // No published route; the invariant is held at the domain.
    assert.equal(rates.status, 200, rates.text);
    const published = JSON.stringify(rates.body);
    assert.ok(
      !published.includes('Rebar supply, cut, bend and fix'),
      'a model’s view of the market came back as one of this business’s own rates',
    );
  });
});
