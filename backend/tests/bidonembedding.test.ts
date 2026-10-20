import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as billing from '../src/domain/bidon/billing.ts';
import * as engine from '../src/domain/bidon/engine.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { EMBEDDING_DIMENSIONS, textsOf } from '../src/ai/providers/embedding.ts';
import { MINIMUM_SIMILARITY } from '../src/datalayer/vectorindex.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { AIProvider } from '../src/goldenthread/types.ts';
import type { AIProviderAdapter, ProviderRequest } from '../src/ai/providers/types.ts';

/**
 * Ranking this customer's library by meaning instead of by shared words.
 *
 * `docs/STATE.md` carried "the embedding swap in `retrieveFor`" as the last
 * outstanding item in Bid-On. These tests are what let that entry close.
 *
 * ## What is proven here, and what is not
 *
 * Proven: the **wiring and the refusals**. That a question is embedded and
 * compared only against passages in the same model's space; that the similarity
 * floor still returns nothing rather than the nearest irrelevant passage; that
 * an unconfigured deployment is refused by name and charged nothing; that
 * re-reading an item drops its vectors; that the wall between two customers
 * holds on the semantic path exactly as it does on the free one; and that the
 * drafter uses the semantic path when the library is in the right space and
 * says which path it used either way.
 *
 * Not proven, and not claimed: the **quality** of an embedding. No call is made
 * to a vendor from this repository, on the same terms as every other
 * provider-backed capability here — `tests/embedding.test.ts` makes the same
 * distinction about the same capability. The adapter below returns vectors this
 * file chose, so what the cosine arithmetic is being asked to demonstrate is
 * that the plumbing carries meaning from the question to the passage, not that
 * a real model would agree about which passages are close.
 */

/** One axis of the space. Cosine of two different axes is exactly zero. */
function axis(at: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === at ? 1 : 0));
}

/**
 * The stand-in's reading, chosen by this file.
 *
 * Three topics on three orthogonal axes. A question and a passage about the
 * same topic score 1; about different topics, 0. That is cruder than a real
 * model and it is the right crudeness for testing a floor and a space: the
 * only thing being exercised is whether the right vectors reach the right
 * comparison.
 */
const TOPICS: Array<{ at: number; words: string[] }> = [
  { at: 0, words: ['wellbeing', 'counselling', 'occupational health', 'mental'] },
  { at: 1, words: ['apprentice', 'local employment', 'training'] },
  { at: 2, words: ['carbon', 'emissions', 'diesel'] },
];

function readingOf(text: string): number[] {
  const lower = text.toLowerCase();
  const topic = TOPICS.find((entry) => entry.words.some((word) => lower.includes(word)));
  // An unrecognised text sits on its own axis, so it matches nothing. That is
  // the honest stand-in behaviour: this file has no opinion about it.
  return axis(topic ? topic.at : 9);
}

/**
 * An embedding adapter that answers from the table above, with no socket.
 *
 * `transmits: false` is an accurate declaration and not a way round a check.
 * These adapters open no connection — they answer from a table in this file —
 * and clearance is a statement about a *vendor contract*, so where there is no
 * vendor there is nothing for it to be a statement about. A real adapter
 * transmits, and the test below asserts that a transmitting one is refused
 * COMMERCIAL_L3 material until an operator clears it.
 */
function embedder(name: AIProvider): AIProviderAdapter {
  return {
    name,
    capability: 'EMBEDDING',
    multimodal: false,
    transmits: false,
    healthy: () => true,
    estimateCostMinor: () => 1,
    execute: async (request: ProviderRequest) => ({
      provider: name,
      modelClass: 'embedding-standard',
      output: { vectors: textsOf(request).map(readingOf) },
      rawCostMinor: 1,
      latencyMs: 1,
    }),
  };
}

/** A reasoning adapter that drafts from whatever passages it is handed. */
function drafter(name: AIProvider): AIProviderAdapter {
  return {
    name,
    capability: 'REASONING',
    multimodal: true,
    transmits: false,
    healthy: () => true,
    estimateCostMinor: () => 10,
    execute: async (request: ProviderRequest) => {
      const payload = request.payload as { passages?: Array<{ chunkId: string; text: string }> };
      const passages = payload.passages ?? [];
      return {
        provider: name,
        modelClass: 'reasoning-standard',
        // Cites what it was given, which is the only thing `recordAnswer` will
        // accept — a citation that is not this customer's own is refused there.
        output: {
          body: ['We do, and here is how.', passages.map((passage) => passage.text).join(' ')],
          citations: passages.map((passage) => passage.chunkId),
          unsupported: [],
        },
        rawCostMinor: 10,
        latencyMs: 1,
      };
    },
  };
}

/** A perception adapter, present only so the orchestrator has a full chain. */
function perceiver(name: AIProvider): AIProviderAdapter {
  return {
    name,
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: false,
    healthy: () => true,
    estimateCostMinor: () => 5,
    execute: async () => ({ provider: name, modelClass: 'x', output: {}, rawCostMinor: 5, latencyMs: 1 }),
  };
}

const DEADLINE = '2027-06-01';

/** Shares no word of four letters or more with the wellbeing question below. */
const WELLBEING_PASSAGE =
  'Every operative has access to an occupational health scheme and a 24-hour counselling line, and supervisors are ' +
  'trained to notice when somebody is struggling.';
const APPRENTICE_PASSAGE =
  'We take two apprentices through a level 3 NVQ on every scheme over one million pounds, with the college nearest ' +
  'the site, and report starts and completions quarterly.';
const WELLBEING_QUESTION = 'How do you look after the wellbeing of the people on your sites?';

/** A platform whose embedding capability is on, with the stand-in above. */
async function withEmbedding(provider: AIProvider = 'OPENAI'): Promise<{ platform: Platform; seed: SeedResult }> {
  const platform = new Platform(
    new AIOrchestrator({
      reasoning: drafter('OPENAI'),
      perception: perceiver('GEMINI'),
      embedding: embedder(provider),
    }),
  );
  const seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });
  return { platform, seed };
}

type Harness = {
  platform: Platform;
  seed: SeedResult;
  admin: () => EngineContext;
  writer: () => EngineContext;
  customerId: string;
  engagementId: string;
  wellbeing: evidence.BidOnEvidence;
  apprentice: evidence.BidOnEvidence;
};

/** A customer with an active engagement and two read, unembedded items. */
async function harness(provider: AIProvider = 'OPENAI'): Promise<Harness> {
  const { platform, seed } = await withEmbedding(provider);
  const admin = (): EngineContext =>
    platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const writer = (): EngineContext =>
    platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

  const customer = customers.openCustomer(admin(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.assignStaff(admin(), customer.id, { add: [writer().auth.actorId] });
  const engagement = engagements.openEngagement(admin(), {
    customerAccountId: customer.id,
    name: 'UVDB prequalification',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(admin(), engagement.id);

  const file = (title: string, text: string): evidence.BidOnEvidence => {
    const item = evidence.fileEvidence(admin(), {
      customerAccountId: customer.id,
      type: 'POLICY',
      title,
      hash: `sha256:${title.padEnd(64, 'x').slice(0, 64)}`,
    });
    return evidence.recordExtraction(admin(), item.id, {
      extractedText: [text],
      chunks: [{ text, pageRef: 'page 4' }],
    });
  };

  return {
    platform,
    seed,
    admin,
    writer,
    customerId: customer.id,
    engagementId: engagement.id,
    wellbeing: file('Workforce wellbeing policy', WELLBEING_PASSAGE),
    apprentice: file('Social value policy', APPRENTICE_PASSAGE),
  };
}

describe('the embedding path is wired in, and its author is recorded', () => {
  it('routes both commands and keeps the free read beside the paid one', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/bid-on/customers/:customerId/retrieval'],
      ['POST', '/v1/bid-on/customers/:customerId/retrieval'],
      ['POST', '/v1/bid-on/evidence/:evidenceId/embedding'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // The paid one is a POST and declares the capability, so it is quoted
    // before it runs; the free one stays a GET a screen may call.
    const paid = ROUTES.find(
      (route) => route.method === 'POST' && route.pattern === '/v1/bid-on/customers/:customerId/retrieval',
    )!;
    assert.equal(paid.ai?.capability, 'EMBEDDING');
    assert.equal(paid.quoteScope, 'TENANT');
    const free = ROUTES.find(
      (route) => route.method === 'GET' && route.pattern === '/v1/bid-on/customers/:customerId/retrieval',
    )!;
    assert.equal(free.ai, undefined);
    assert.equal(free.readOnly, true);
  });

  it('refuses a vendor that is not cleared for a customer’s commercial material', async () => {
    // The production requirement, recorded here rather than discovered on a
    // host. Everything Bid-On sends is COMMERCIAL_L3 — a customer's insurance
    // values, accident figures and case studies — and the default clearance is
    // INTERNAL. So a real, transmitting vendor is refused until an operator
    // states, per vendor, that the contract with them permits that level.
    const transmitting: AIProviderAdapter = { ...embedder('OPENAI'), transmits: true };
    const platform = new Platform(
      new AIOrchestrator({
        reasoning: drafter('OPENAI'),
        perception: perceiver('GEMINI'),
        embedding: transmitting,
      }),
    );
    const seed = await seedDemoProject(platform);
    platform.setModuleGrant({
      moduleId: 'BID_ON',
      tenantId: seed.tenantId,
      status: 'ACTIVE',
      reason: 'Allocated under the signed Bid-On agreement',
      agreementRef: 'AGR-BIDON-2026-001',
      decidedBy: seed.users.operator!.id,
    });
    const admin = platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const customer = customers.openCustomer(admin, { legalName: 'Clearance Test Ltd' });
    const engagement = engagements.openEngagement(admin, {
      customerAccountId: customer.id,
      name: 'Clearance',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 100_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(admin, engagement.id);
    const item = evidence.recordExtraction(
      admin,
      evidence.fileEvidence(admin, {
        customerAccountId: customer.id,
        type: 'POLICY',
        title: 'Workforce wellbeing policy',
        hash: `sha256:${'c'.repeat(64)}`,
      }).id,
      { extractedText: [WELLBEING_PASSAGE], chunks: [{ text: WELLBEING_PASSAGE }] },
    );

    const refusal = await rejectsCode(() => engine.embedEvidence(admin, item.id), 'AI_CLEARANCE_REQUIRED');
    assert.match(String(refusal.message), /AI_PROVIDER_CLEARANCE/);
  });

  it('records the vectors under an event a model may author', () => {
    // The author genuinely is a model, and the record has to say which one: a
    // cosine between two models' vectors is not a weaker score, it is a number
    // with no meaning.
    assert.equal(lookupEventType('BID_ON_EVIDENCE_EMBEDDED')?.aiAllowed, true);
    assert.equal(lookupEventType('BID_ON_EVIDENCE_EMBEDDED')?.entity, 'BidOnEvidence');
  });
});

describe('a deployment with no embedding provider is refused by name', () => {
  let bare: Harness;

  before(async () => {
    // The ordinary state of a deployment that has not turned semantic search
    // on: a reasoning and a perception adapter, and no embedding one.
    const platform = new Platform(
      new AIOrchestrator({ reasoning: drafter('OPENAI'), perception: perceiver('GEMINI') }),
    );
    const seed = await seedDemoProject(platform);
    platform.setModuleGrant({
      moduleId: 'BID_ON',
      tenantId: seed.tenantId,
      status: 'ACTIVE',
      reason: 'Allocated under the signed Bid-On agreement',
      agreementRef: 'AGR-BIDON-2026-001',
      decidedBy: seed.users.operator!.id,
    });
    const admin = (): EngineContext =>
      platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const customer = customers.openCustomer(admin(), { legalName: 'Pennine Grid Services Ltd' });
    const engagement = engagements.openEngagement(admin(), {
      customerAccountId: customer.id,
      name: 'No embeddings here',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 100_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(admin(), engagement.id);
    const item = evidence.recordExtraction(
      admin(),
      evidence.fileEvidence(admin(), {
        customerAccountId: customer.id,
        type: 'POLICY',
        title: 'Workforce wellbeing policy',
        hash: `sha256:${'d'.repeat(64)}`,
      }).id,
      { extractedText: [WELLBEING_PASSAGE], chunks: [{ text: WELLBEING_PASSAGE }] },
    );
    bare = {
      platform,
      seed,
      admin,
      writer: admin,
      customerId: customer.id,
      engagementId: engagement.id,
      wellbeing: item,
      apprentice: item,
    };
  });

  it('refuses both commands with the variable that turns them on, and charges nothing', async () => {
    const before = bare.platform.wallet(bare.seed.tenantId).snapshot();

    const embed = await rejectsCode(
      () => engine.embedEvidence(bare.admin(), bare.wellbeing.id),
      'AI_EMBEDDING_NOT_CONFIGURED',
    );
    assert.match(String(embed.message), /AI_EMBEDDING_PROVIDER/);

    await rejectsCode(
      () =>
        engine.retrieveSemantic(bare.admin(), {
          customerAccountId: bare.customerId,
          question: WELLBEING_QUESTION,
        }),
      'AI_EMBEDDING_NOT_CONFIGURED',
    );

    // Resolved before anything is held, so the refusal costs nothing rather
    // than surfacing as a hold that is then released.
    assert.deepEqual(bare.platform.wallet(bare.seed.tenantId).snapshot(), before);
  });

  it('still answers the free read, and says it is not semantic search', () => {
    const result = evidence.retrieveFor(bare.admin(), {
      customerAccountId: bare.customerId,
      question: 'describe your health and safety arrangements',
      asAt: DEADLINE,
    });
    assert.equal(result.method, 'TERM_OVERLAP');
    assert.equal(result.model, undefined);
    assert.match(result.note, /not semantic search/i);
  });
});

describe('term overlap misses what the question asks in other words', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });

  it('finds nothing for a question that shares no words with the answer', () => {
    // The passage answers this question and shares not one distinctive word
    // with it. This is the gap the swap exists to close, asserted before it is
    // closed so the improvement is a measured one rather than a claim.
    const result = evidence.retrieveFor(h.admin(), {
      customerAccountId: h.customerId,
      question: WELLBEING_QUESTION,
      asAt: DEADLINE,
    });
    assert.equal(result.method, 'TERM_OVERLAP');
    assert.deepEqual(result.chunks, []);
    assert.equal(result.skipped, 0);
  });

  it('says in the library read which items will only be found by words', () => {
    const library = evidence.evidenceLibrary(h.admin(), h.customerId);
    assert.ok(library.evidence.every((item) => item.semanticModel === undefined));
    assert.ok(
      library.limits.some((line) => /not embedded/i.test(line)),
      'the library does not say its passages are found by words only',
    );
  });
});

describe('embedded, the same question finds the same passage by meaning', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    await engine.embedEvidence(h.admin(), h.wellbeing.id);
    await engine.embedEvidence(h.admin(), h.apprentice.id);
  });

  it('writes the vectors, the space and what it cost', () => {
    const stored = evidence.requireEvidence(h.admin(), h.wellbeing.id);
    assert.equal(stored.semanticModel?.provider, 'OPENAI');
    assert.equal(stored.semanticModel?.modelClass, 'embedding-standard');
    assert.equal(stored.semanticModel?.dimensions, EMBEDDING_DIMENSIONS);
    assert.equal(stored.chunks[0]?.vector?.length, EMBEDDING_DIMENSIONS);

    const library = evidence.evidenceLibrary(h.admin(), h.customerId);
    assert.ok(library.evidence.every((item) => item.semanticModel !== undefined));
    assert.ok(!library.limits.some((line) => /not embedded/i.test(line)));
  });

  it('ranks by meaning, names the space, and still refuses below the floor', async () => {
    const result = await engine.retrieveSemantic(h.admin(), {
      customerAccountId: h.customerId,
      question: WELLBEING_QUESTION,
      asAt: DEADLINE,
    });

    assert.equal(result.method, 'EMBEDDING');
    assert.equal(result.model, 'OPENAI/embedding-standard');
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0]?.evidenceId, h.wellbeing.id);
    assert.ok(result.chunks[0]!.score >= MINIMUM_SIMILARITY);
    assert.ok(result.acuConsumed > 0, 'a model call that was made has to be charged');

    // Both passages were compared and the apprenticeship one was refused. The
    // floor is what turns "here are the two closest things" into "there is
    // nothing here about that" — which is the answer an unfiltered index can
    // never give.
    assert.equal(result.considered, 2);
    assert.equal(result.skipped, 0);
  });

  it('returns nothing at all for a question the library does not address', async () => {
    const result = await engine.retrieveSemantic(h.admin(), {
      customerAccountId: h.customerId,
      question: 'What is your approach to reducing diesel use on site?',
      asAt: DEADLINE,
    });
    assert.deepEqual(result.chunks, []);
    assert.equal(result.considered, 2);
    assert.match(result.note, /makes it a gap the customer can fix/);
  });

  it('refuses a second embedding by the same model, and replaces the rows under another', async () => {
    const again = await rejectsCode(
      () => engine.embedEvidence(h.admin(), h.wellbeing.id),
      'BID_ON_ALREADY_EMBEDDED',
    );
    assert.match(String(again.message), /charged again/);
  });

  it('drops the vectors when the item is read again', () => {
    // The passages are replaced, so everything derived from them goes too. An
    // item that said it was embedded while its passages were not would drop
    // out of every semantic search with nothing to explain why.
    const reread = evidence.recordExtraction(h.admin(), h.apprentice.id, {
      extractedText: [APPRENTICE_PASSAGE],
      chunks: [{ text: APPRENTICE_PASSAGE, pageRef: 'page 7' }],
    });
    assert.equal(reread.semanticModel, undefined);
    assert.ok(reread.chunks.every((chunk) => chunk.vector === undefined));

    const library = evidence.evidenceLibrary(h.admin(), h.customerId);
    assert.ok(
      library.limits.some((line) => /not embedded/i.test(line)),
      'a re-read item is not reported as needing embedding again',
    );
  });
});

describe('nothing is ever compared across two models’ spaces', () => {
  it('skips a passage embedded by another vendor, and says how many', async () => {
    const h = await harness('OPENAI');
    await engine.embedEvidence(h.admin(), h.wellbeing.id);

    // The same library, queried with a vector from a different vendor's space.
    // A cosine between the two is not a lower number — it is undefined — so
    // the passage is not scored at all.
    const crossSpace = evidence.retrieveFor(h.admin(), {
      customerAccountId: h.customerId,
      question: WELLBEING_QUESTION,
      asAt: DEADLINE,
      queryVector: axis(0),
      queryModel: { provider: 'GEMINI', modelClass: 'embedding-standard' },
    });

    assert.equal(crossSpace.method, 'EMBEDDING');
    assert.deepEqual(crossSpace.chunks, []);
    assert.equal(crossSpace.considered, 0);
    assert.ok(crossSpace.skipped >= 1);
    assert.match(crossSpace.note, /different space/i);
  });

  it('refuses a vector of the wrong width rather than scoring against it', async () => {
    const h = await harness();
    await engine.embedEvidence(h.admin(), h.wellbeing.id);

    // Not a smaller score: `cosine` refuses mismatched dimensions outright, so
    // a short query vector has to be skipped before it reaches the comparison.
    const narrow = evidence.retrieveFor(h.admin(), {
      customerAccountId: h.customerId,
      question: WELLBEING_QUESTION,
      asAt: DEADLINE,
      queryVector: [1, 0, 0],
      queryModel: { provider: 'OPENAI', modelClass: 'embedding-standard' },
    });
    assert.deepEqual(narrow.chunks, []);
    assert.ok(narrow.skipped >= 1);
  });
});

describe('the wall between customers holds on the paid path too', () => {
  it('never returns another customer’s passage, and refuses an unassigned reader', async () => {
    const h = await harness();
    const rival = customers.openCustomer(h.admin(), { legalName: 'Calder Civils Ltd' });
    const rivalEngagement = engagements.openEngagement(h.admin(), {
      customerAccountId: rival.id,
      name: 'Same framework, other side',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 150_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(h.admin(), rivalEngagement.id);
    const theirs = evidence.recordExtraction(
      h.admin(),
      evidence.fileEvidence(h.admin(), {
        customerAccountId: rival.id,
        type: 'POLICY',
        title: 'Their wellbeing policy',
        hash: `sha256:${'e'.repeat(64)}`,
      }).id,
      { extractedText: [WELLBEING_PASSAGE], chunks: [{ text: WELLBEING_PASSAGE }] },
    );
    await engine.embedEvidence(h.admin(), theirs.id);
    await engine.embedEvidence(h.admin(), h.wellbeing.id);

    // Both customers hold a passage that answers this question, embedded in
    // one space by one model. The filter runs before the ranking, so the only
    // one that can come back is this customer's own.
    const mine = await engine.retrieveSemantic(h.admin(), {
      customerAccountId: h.customerId,
      question: WELLBEING_QUESTION,
      asAt: DEADLINE,
    });
    assert.equal(mine.chunks.length, 1);
    assert.equal(mine.chunks[0]?.evidenceId, h.wellbeing.id);

    // And the bid writer, who is assigned to one customer and not the other,
    // cannot ask the question of the one they may not see.
    await rejectsCode(
      () =>
        engine.retrieveSemantic(h.writer(), {
          customerAccountId: rival.id,
          question: WELLBEING_QUESTION,
        }),
      'BID_ON_CUSTOMER_NOT_ASSIGNED',
    );
    await rejectsCode(() => engine.embedEvidence(h.writer(), theirs.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');
  });
});

describe('embedding is a spend, and the spend rules apply to it', () => {
  it('is refused where the deposit is outstanding', async () => {
    const h = await harness();
    // A second customer whose engagement carries a deposit nobody has paid.
    const customer = customers.openCustomer(h.admin(), { legalName: 'Ribble Mechanical Ltd' });
    const engagement = engagements.openEngagement(h.admin(), {
      customerAccountId: customer.id,
      name: 'Deposit outstanding',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 200_000,
      currency: 'GBP',
      depositPercent: 50,
    });
    engagements.activateEngagement(h.admin(), engagement.id);
    const item = evidence.recordExtraction(
      h.admin(),
      evidence.fileEvidence(h.admin(), {
        customerAccountId: customer.id,
        type: 'POLICY',
        title: 'Their wellbeing policy',
        hash: `sha256:${'f'.repeat(64)}`,
      }).id,
      { extractedText: [WELLBEING_PASSAGE], chunks: [{ text: WELLBEING_PASSAGE }] },
    );

    const refusal = await rejectsCode(
      () => engine.embedEvidence(h.admin(), item.id),
      'BID_ON_DEPOSIT_OUTSTANDING',
    );
    assert.match(String(refusal.message), /outstanding/);

    // Filing and reading it are not blocked — only the spend is. That is the
    // whole distinction the deposit gate is built on.
    assert.equal(evidence.evidenceLibrary(h.admin(), customer.id).evidence.length, 1);

    // Waived with a reason, and the same command goes through.
    const deposit = billing
      .invoiceRegister(h.admin())
      .invoices.find((invoice) => invoice.engagementId === engagement.id && invoice.kind === 'DEPOSIT')!;
    billing.waiveInvoice(h.admin(), deposit.id, {
      reason: 'Long-standing customer starting on a handshake; agreed with the director.',
    });
    const embedded = await engine.embedEvidence(h.admin(), item.id);
    assert.equal(embedded.provider, 'OPENAI');
  });

  it('refuses an item with nothing read out of it, and a withdrawn one', async () => {
    const h = await harness();
    const unread = evidence.fileEvidence(h.admin(), {
      customerAccountId: h.customerId,
      type: 'POLICY',
      title: 'Filed but never read',
      hash: `sha256:${'a'.repeat(64)}`,
    });
    await rejectsCode(() => engine.embedEvidence(h.admin(), unread.id), 'BID_ON_NOTHING_EXTRACTED');

    evidence.withdrawEvidence(h.admin(), h.apprentice.id, {
      reason: 'Superseded by the 2027 policy and should not be cited again.',
    });
    await rejectsCode(() => engine.embedEvidence(h.admin(), h.apprentice.id), 'BID_ON_EVIDENCE_WITHDRAWN');
  });

  it('refuses a customer with no engagement open for work', async () => {
    const h = await harness();
    const customer = customers.openCustomer(h.admin(), { legalName: 'No engagement yet Ltd' });
    const item = evidence.recordExtraction(
      h.admin(),
      evidence.fileEvidence(h.admin(), {
        customerAccountId: customer.id,
        type: 'POLICY',
        title: 'Their wellbeing policy',
        hash: `sha256:${'b'.repeat(64)}`,
      }).id,
      { extractedText: [WELLBEING_PASSAGE], chunks: [{ text: WELLBEING_PASSAGE }] },
    );
    const refusal = await rejectsCode(
      () => engine.embedEvidence(h.admin(), item.id),
      'BID_ON_NO_OPEN_ENGAGEMENT',
    );
    // The ACU has to be attributable to a piece of commercial work, which is
    // what lets a provider read its own margin per customer.
    assert.match(String(refusal.message), /margin/);
  });

  it('refuses a question too short to rank against anything', async () => {
    const h = await harness();
    await rejectsCode(
      () => engine.retrieveSemantic(h.admin(), { customerAccountId: h.customerId, question: 'safety' }),
      'BID_ON_QUESTION_TOO_SHORT',
    );
  });
});

describe('the drafter uses the semantic path, and says which path it used', () => {
  it('drafts from a passage term overlap would have missed', async () => {
    const h = await harness();
    await engine.embedEvidence(h.admin(), h.wellbeing.id);

    const bid = bids.createBid(h.admin(), {
      engagementId: h.engagementId,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    bids.confirmQuestions(h.admin(), bid.id, {
      questions: [
        {
          section: 'Social value',
          number: 'Q1',
          text: WELLBEING_QUESTION,
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
      ],
    });
    const question = bids.requireBid(h.admin(), bid.id).questions[0]!;

    const drafted = await engine.draftAnswer(h.admin(), bid.id, { questionId: question.id });

    assert.equal(drafted.outcome, 'DRAFTED');
    assert.equal(drafted.retrieval?.method, 'EMBEDDING');
    assert.equal(drafted.retrieval?.model, 'OPENAI/embedding-standard');
    // The draft and the embedding behind it, as one number: one press of one
    // button is what the provider is charged for.
    assert.ok(drafted.acuConsumed > 0);

    const answer = bids.latestAnswer(bids.requireBid(h.admin(), bid.id), question.id)!;
    assert.equal(answer.authorship, 'AI_DRAFTED');
    assert.equal(answer.citations.length, 1);
    assert.equal(answer.citations[0]?.evidenceId, h.wellbeing.id);
  });

  it('falls back to term overlap where nothing is embedded, and names that', async () => {
    const h = await harness();
    // The same library and the same question as the test above, with nothing
    // embedded. It raises a gap — the word search cannot reach a passage that
    // answers in other words — and it says the ranking was TERM_OVERLAP, which
    // is the fact that tells a reviewer the answer may be in the library
    // already rather than missing from it.
    const bid = bids.createBid(h.admin(), {
      engagementId: h.engagementId,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    bids.confirmQuestions(h.admin(), bid.id, {
      questions: [
        {
          section: 'Social value',
          number: 'Q1',
          text: WELLBEING_QUESTION,
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
      ],
    });
    const question = bids.requireBid(h.admin(), bid.id).questions[0]!;

    const drafted = await engine.draftAnswer(h.admin(), bid.id, { questionId: question.id });
    assert.equal(drafted.outcome, 'GAP_RAISED');
    assert.equal(drafted.retrieval?.method, 'TERM_OVERLAP');
    assert.equal(drafted.retrieval?.model, undefined);
    // No model was called at all on this path, so nothing was charged.
    assert.equal(drafted.acuConsumed, 0);

    // And what the customer is asked carries none of the plumbing: no ranking
    // method, no model, no advice about embedding a library they cannot see.
    const gap = bids.requireBid(h.admin(), bid.id).gaps.find((entry) => entry.id === drafted.gapId)!;
    assert.doesNotMatch(gap.promptToClient, /embed|overlap|semantic|vector/i);
  });

  it('drafts the question the word search could not reach, once the library is embedded', async () => {
    // The pair that makes the swap worth having, asserted as a pair: same
    // library, same question, nothing embedded raises a gap and embedded
    // produces a cited draft.
    const h = await harness();
    const bid = bids.createBid(h.admin(), {
      engagementId: h.engagementId,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    bids.confirmQuestions(h.admin(), bid.id, {
      questions: [
        {
          section: 'Social value',
          number: 'Q1',
          text: WELLBEING_QUESTION,
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
      ],
    });
    const question = bids.requireBid(h.admin(), bid.id).questions[0]!;

    const before = await engine.draftAnswer(h.admin(), bid.id, { questionId: question.id });
    assert.equal(before.outcome, 'GAP_RAISED');

    // The gap is closed so the drafter is not blocked by its own refusal, the
    // library is embedded, and the same question is asked again.
    bids.resolveGap(h.admin(), bid.id, before.gapId!, {
      note: 'Withdrawn: the policy on file does answer this once it can be found.',
    });
    await engine.embedEvidence(h.admin(), h.wellbeing.id);

    const after = await engine.draftAnswer(h.admin(), bid.id, { questionId: question.id });
    assert.equal(after.outcome, 'DRAFTED');
    assert.equal(after.retrieval?.method, 'EMBEDDING');
  });
});
