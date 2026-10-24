import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bidEngine from '../src/domain/bidon/engine.ts';
import { GREEN_FLOOR } from '../src/domain/bidon/rubric.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { EvidenceStore } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The drafter, run end to end, with a provider that answers.
 *
 * ## Why this file exists
 *
 * Four defects in one week all had the same shape — an event type never
 * registered, a route schema that made a domain branch unreachable, a proposal
 * the console never displayed, a yes/no field the drafter never asked for — and
 * every one of them failed on the **last line of the command, after the vendor
 * had been called and billed**. `docs/STATE.md` names the pattern four times:
 * an AI command's success path is the least-tested code in the platform,
 * because it cannot run without a live model.
 *
 * It can. `AIOrchestrator` takes adapter overrides precisely so that a test
 * gets exactly the adapters it hands in and nothing reaches the network behind
 * its back. So the drafting loop — three to five model calls, a self-marking
 * revision, a stopping rule and a fallback at every step — is exercised here
 * against a provider that is scripted rather than mocked out: it answers in the
 * shapes a vendor really answers in, and each test says what it is answering.
 *
 * ## What this proves and what it does not
 *
 * It proves the **platform's** half: that the passes run in order, that each is
 * given what it needs, that the loop stops where it is supposed to, that the
 * best attempt survives and a bad one does not, and that every refusal fires
 * where it should. It proves nothing about how a real model writes — that is
 * the vendor's half, and it is measured on a deployment, not asserted in a
 * suite.
 */

/** What one scripted call did, for assertions about the pass that made it. */
type Seen = { task: string; payload: Record<string, unknown> };

/**
 * A provider that answers from a script.
 *
 * Not a mock in the usual sense: it records what it was asked, and answers with
 * whatever the test says the vendor said — including the malformed, the empty
 * and the implausible, which is where this platform's AI defects have all
 * lived.
 */
type Reply = Record<string, unknown> | ((payload: Record<string, unknown>) => Record<string, unknown>);

function scripted(replies: Reply[]): AIProviderAdapter & { seen: Seen[] } {
  const seen: Seen[] = [];
  let at = 0;
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: false,
    seen,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      seen.push({ task: request.task, payload: request.payload });
      const reply = replies[Math.min(at, replies.length - 1)] ?? {};
      const output = typeof reply === 'function' ? reply(request.payload) : reply;
      at += 1;
      return {
        provider: 'OPENAI',
        modelClass: 'test',
        output,
        rawCostMinor: 40,
        latencyMs: 5,
      };
    },
  };
}

/** The plan pass's answer, in the shape the engine asks for. */
const PLAN = (payload: Record<string, unknown>): Record<string, unknown> => ({
  limbs: [{ asks: 'How assessments are delivered', chunkIds: [offeredId(payload)], evidenced: true }],
  missing: [],
  shape: 'One paragraph per limb, in the order asked.',
});

/** Marks that clear the floor, so a revision stops. */
const GREEN_MARKS = {
  COMPLIANCE: 90,
  EVIDENCE: 85,
  BUYER_RELEVANCE: 88,
  SPECIFICITY: 84,
  CLARITY_AND_LIMITS: 90,
};

/** Marks well below it, so a revision goes round again. */
const THIN_MARKS = {
  COMPLIANCE: 50,
  EVIDENCE: 45,
  BUYER_RELEVANCE: 55,
  SPECIFICITY: 40,
  CLARITY_AND_LIMITS: 60,
};

/**
 * A draft that cites what it was actually offered.
 *
 * The first version of this file cited a made-up chunk id and every test came
 * back `GAP_RAISED` — which is the platform behaving correctly: a citation the
 * retriever never offered is dropped, and an answer left citing nothing is a
 * gap. Worth keeping as a note, because it is the same mistake a real model
 * makes and the reason the drop exists.
 */
const offeredId = (payload: Record<string, unknown>, at = 0): string => {
  const passages = (payload.passages ?? []) as Array<{ chunkId: string }>;
  return passages[at]?.chunkId ?? 'nothing-was-offered';
};

const draftReply =
  (body: string[], over: Record<string, unknown> = {}) =>
  (payload: Record<string, unknown>): Record<string, unknown> => ({
    body,
    citations: [offeredId(payload)],
    unsupported: [],
    ...over,
  });

let platform: Platform;
let seed: SeedResult;
let directory: string;
let engagement: engagements.Engagement;
let customer: customers.CustomerAccount;

const asDirector = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/**
 * A platform whose reasoning provider is the script, with one customer, one
 * engagement, one filed and extracted document and one bid.
 *
 * Built per test rather than shared, because the thing under test writes to the
 * ledger and a second test reading the first one's answers would be testing the
 * order the file happens to be in.
 */
async function withProvider(adapter: AIProviderAdapter): Promise<{ bid: bids.Bid; questionId: string }> {
  platform = new Platform(new AIOrchestrator({ reasoning: adapter }), new EvidenceStore(join(directory, `s-${Math.random()}`)));
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });

  customer = customers.openCustomer(asDirector(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.updateCustomerProfile(asDirector(), customer.id, {
    companyNumber: '09876543',
    sectors: ['Social housing'],
    regions: ['West Midlands'],
    headcount: 48,
  });

  engagement = engagements.openEngagement(asDirector(), {
    customerAccountId: customer.id,
    name: 'EPC framework',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asDirector(), engagement.id);

  let filed = evidence.fileEvidence(asDirector(), {
    customerAccountId: customer.id,
    type: 'POLICY',
    title: 'EPC delivery method statement 2026',
    hash: `sha256:${'f'.repeat(64)}`,
  });
  filed = evidence.recordExtraction(asDirector(), filed.id, {
    extractedText: ['Our EPC assessments are completed within ten working days of instruction.'],
    chunks: [
      {
        pageRef: 'page 2',
        text:
          'Every EPC assessment is completed within ten working days of instruction by a nominated domestic energy ' +
          'assessor and lodged on the central register within five working days of completion.',
      },
    ],
  });

  let bid = bids.createBid(asDirector(), {
    engagementId: engagement.id,
    buyerName: 'Platform Housing Group',
    scheme: 'ITT',
    deadline: '2026-11-02',
  });
  bid = bids.confirmQuestions(asDirector(), bid.id, {
    questions: [
      {
        section: 'Quality',
        number: '2.01',
        text: 'Describe your approach to EPC assessment at scale, including how you report progress.',
        answerType: 'TEXT',
        wordLimit: 500,
        weighting: 40,
        mandatory: true,
      },
    ],
  });

  return { bid, questionId: bid.questions[0]!.id };
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-bidon-draft-'));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('one press of Draft an answer, end to end', () => {
  it('plans, writes, revises once when the revision marks itself green, and records', async () => {
    const adapter = scripted([
      PLAN,
      draftReply(['We complete every assessment within ten working days of instruction.']),
      draftReply(
        [
          'We complete every assessment within ten working days of instruction, by a nominated domestic energy assessor.',
          'Each certificate is lodged on the central register within five working days of completion.',
        ],
        { selfScore: GREEN_MARKS, tookMarksOffFor: ['The first draft named no reporting route'] },
      ),
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(drafted.outcome, 'DRAFTED');
    assert.equal(adapter.seen.length, 3, 'plan, write, one revision — it stopped as soon as it was green');

    // The passes ran in order and each was given its own job.
    assert.match(adapter.seen[0]!.task, /Plan one answer/);
    assert.match(adapter.seen[0]!.task, /Do not write the answer/);
    assert.match(adapter.seen[1]!.task, /Write one answer/);
    assert.match(adapter.seen[2]!.task, /Mark this draft/);

    // The recorded answer is the revision, not the first draft.
    const written = bids.latestAnswer(drafted.bid, questionId);
    assert.ok(written);
    assert.equal(written.body.length, 2);
    assert.match(written.body[1]!, /central register/);
    assert.equal(written.authorship, 'AI_DRAFTED');
    assert.equal(written.citations.length, 1, 'and it carries the citation the retriever offered');
  });

  it('gives every pass the passages, and the writer the plan the planner made', async () => {
    const adapter = scripted([PLAN, draftReply(['Drafted.']), draftReply(['Revised.'], { selfScore: GREEN_MARKS })]);
    const { bid, questionId } = await withProvider(adapter);
    await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    for (const [at, pass] of adapter.seen.entries()) {
      const passages = pass.payload.passages as Array<{ text: string }>;
      assert.ok(Array.isArray(passages) && passages.length > 0, `pass ${at + 1} was given the evidence`);
      assert.match(passages[0]!.text, /ten working days/);
    }

    // The plan reaches the writer as structure, not as a suggestion.
    const writing = adapter.seen[1]!.payload.plan as { limbs?: Array<{ asks: string }>; shape?: unknown };
    assert.equal(writing.limbs?.[0]?.asks, 'How assessments are delivered');
    assert.equal(writing.shape, 'One paragraph per limb, in the order asked.');

    // And the revision is given the draft it is marking.
    assert.ok(adapter.seen[2]!.payload.theDraft, 'the reviser sees what it is revising');
  });

  it('tells every pass what this platform knows about the company', async () => {
    // The facts a questionnaire's first section asks for are on the customer
    // record, and the drafter used to be handed document passages and nothing
    // else — so a question asking for a company number raised a gap against a
    // platform holding the company number.
    const adapter = scripted([PLAN, draftReply(['Drafted.']), draftReply(['Revised.'], { selfScore: GREEN_MARKS })]);
    const { bid, questionId } = await withProvider(adapter);
    await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    for (const pass of adapter.seen) {
      const facts = pass.payload.ourStandingFacts as { companyNumber?: string; headcount?: number };
      assert.equal(facts.companyNumber, '09876543');
      assert.equal(facts.headcount, 48);
      assert.match(
        String(pass.payload.factsInstruction),
        /without a citation, exactly as recorded and never rounded/,
        'and the rule that they are stated as recorded travels with them',
      );
    }
  });

  it('keeps revising while each rewrite beats the last, and stops at the ceiling', async () => {
    // Four marks, each better than the one before and none of them green: the
    // loop takes all three revisions it is allowed and then hands over the best
    // it got rather than paying for a fourth.
    const climbing = [60, 68, 74].map((mark) => ({
      COMPLIANCE: mark,
      EVIDENCE: mark,
      BUYER_RELEVANCE: mark,
      SPECIFICITY: mark,
      CLARITY_AND_LIMITS: mark,
    }));
    const adapter = scripted([
      PLAN,
      draftReply(['First.']),
      draftReply(['Second.'], { selfScore: climbing[0] }),
      draftReply(['Third.'], { selfScore: climbing[1] }),
      draftReply(['Fourth.'], { selfScore: climbing[2] }),
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(adapter.seen.length, 5, 'plan, write and three revisions — the ceiling, not an open loop');
    assert.equal(bids.latestAnswer(drafted.bid, questionId)!.body[0], 'Fourth.', 'the best of them is the last here');
  });

  it('stops paying the moment a rewrite fails to beat the one before it', async () => {
    // Same error, same approach: a revision that does not improve on its
    // predecessor is the model out of ideas, and a third call buys the second
    // one again.
    const same = { COMPLIANCE: 62, EVIDENCE: 62, BUYER_RELEVANCE: 62, SPECIFICITY: 62, CLARITY_AND_LIMITS: 62 };
    const adapter = scripted([
      PLAN,
      draftReply(['First.']),
      draftReply(['Second.'], { selfScore: same }),
      draftReply(['Third.'], { selfScore: same }),
      draftReply(['Fourth.'], { selfScore: same }),
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(adapter.seen.length, 4, 'plan, write, and two revisions — the second one did not earn a third');
    assert.equal(bids.latestAnswer(drafted.bid, questionId)!.body[0], 'Third.');
  });

  it('keeps the better answer when a rewrite marks itself worse', async () => {
    // A model talking itself downhill does not recover by going round again,
    // and the answer that goes on the record is the best one it produced.
    const better = { COMPLIANCE: 70, EVIDENCE: 70, BUYER_RELEVANCE: 70, SPECIFICITY: 70, CLARITY_AND_LIMITS: 70 };
    const worse = { COMPLIANCE: 40, EVIDENCE: 40, BUYER_RELEVANCE: 40, SPECIFICITY: 40, CLARITY_AND_LIMITS: 40 };
    const adapter = scripted([
      PLAN,
      draftReply(['First.']),
      draftReply(['Better.'], { selfScore: better }),
      draftReply(['Worse.'], { selfScore: worse }),
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(bids.latestAnswer(drafted.bid, questionId)!.body[0], 'Better.', 'the downhill rewrite is discarded');
  });

  it('keeps the draft when a revision comes back empty', async () => {
    // A vendor fault late in the loop must not turn a perfectly good draft into
    // a gap. This is the failure that would have cost somebody a paid call and
    // left them with nothing.
    const adapter = scripted([PLAN, draftReply(['The draft that survives.']), { body: [], citations: [] }]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(drafted.outcome, 'DRAFTED');
    assert.equal(bids.latestAnswer(drafted.bid, questionId)!.body[0], 'The draft that survives.');
  });

  it('raises a gap, not an answer, when the writing cites nothing', async () => {
    // The rule the whole module is built on: prose nobody can check is the
    // thing a buyer will check. It is discarded and the question goes back to
    // the customer.
    const adapter = scripted([
      PLAN,
      { body: ['We are extremely experienced in this field.'], citations: [], unsupported: ['Any evidence at all'] },
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(drafted.outcome, 'GAP_RAISED');
    assert.ok(drafted.gapId);
    assert.equal(bids.latestAnswer(drafted.bid, questionId), undefined, 'nothing uncited reaches the record');
    const gap = drafted.bid.gaps.find((entry) => entry.id === drafted.gapId);
    assert.match(gap!.promptToClient, /Any evidence at all/);
  });

  it('drops a chunk id the model invented rather than refusing the prose', async () => {
    const adapter = scripted([
      PLAN,
      (payload: Record<string, unknown>) => ({
        body: ['Cited properly, and once not.'],
        citations: [offeredId(payload), 'not-a-real-chunk'],
        unsupported: [],
      }),
      (payload: Record<string, unknown>) => ({
        body: ['Revised.'],
        citations: [offeredId(payload), 'invented-again'],
        unsupported: [],
        selfScore: GREEN_MARKS,
      }),
    ]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    const written = bids.latestAnswer(drafted.bid, questionId)!;
    assert.equal(written.citations.length, 1, 'only the passage the retriever actually offered');
  });

  it('refuses to record a yes/no answer the model left unanswered, and keeps the prose', async () => {
    // The defect this file would have caught: the drafter called a vendor, was
    // charged, built the answer and was refused on the last line.
    const adapter = scripted([PLAN, draftReply(['We are registered.']), draftReply(['We are registered.'], { selfScore: GREEN_MARKS })]);
    const { bid: base } = await withProvider(adapter);
    const yesNoBid = bids.confirmQuestions(
      asDirector(),
      bids.createBid(asDirector(), {
        engagementId: engagement.id,
        buyerName: 'Platform Housing Group',
        scheme: 'ITT',
        deadline: '2026-11-02',
      }).id,
      {
        questions: [
          {
            section: 'Central Digital Platform',
            number: '1.2',
            text: 'Are you registered on the Central Digital Platform?',
            answerType: 'YES_NO',
            mandatory: true,
          },
        ],
      },
    );
    assert.ok(base.id !== yesNoBid.id);

    const refusal = await rejectsCode(
      () => bidEngine.draftAnswer(asDirector(), yesNoBid.id, { questionId: yesNoBid.questions[0]!.id }),
      'BID_ON_YES_NO_NOT_DRAFTED',
    );
    assert.match(refusal.message ?? '', /We are registered\./, 'the paid-for draft comes back with the refusal');
  });

  it('records the yes/no the model did answer', async () => {
    const adapter = scripted([
      PLAN,
      draftReply(['We are registered on the Central Digital Platform.'], { yesNo: 'yes' }),
      draftReply(['We are registered on the Central Digital Platform.'], { yesNo: true, selfScore: GREEN_MARKS }),
    ]);
    await withProvider(adapter);
    const yesNoBid = bids.confirmQuestions(
      asDirector(),
      bids.createBid(asDirector(), {
        engagementId: engagement.id,
        buyerName: 'Platform Housing Group',
        scheme: 'ITT',
        deadline: '2026-11-02',
      }).id,
      {
        questions: [
          {
            section: 'Central Digital Platform',
            number: '1.2',
            text: 'Are you registered on the Central Digital Platform?',
            answerType: 'YES_NO',
            mandatory: true,
          },
        ],
      },
    );

    const drafted = await bidEngine.draftAnswer(asDirector(), yesNoBid.id, {
      questionId: yesNoBid.questions[0]!.id,
    });

    assert.equal(drafted.outcome, 'DRAFTED');
    assert.equal(bids.latestAnswer(drafted.bid, yesNoBid.questions[0]!.id)!.yesNo, true);
  });

  it('charges for every pass it made, and nothing it did not', async () => {
    // The spend reported back is what the wallet settled. A loop that stopped
    // after two calls and reported three would be a figure nobody could
    // reconcile against the ledger.
    const adapter = scripted([PLAN, draftReply(['Drafted.']), draftReply(['Revised.'], { selfScore: GREEN_MARKS })]);
    const { bid, questionId } = await withProvider(adapter);

    const drafted = await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(adapter.seen.length, 3);
    assert.ok(drafted.acuConsumed > 0, 'the passes are charged');
  });

  it('reads the question as the several questions it is, before it spends anything', async () => {
    // Deep search on the retrieval side: the question above has two limbs, and
    // both reach the planner's passages through the union.
    const facets = bidEngine.questionFacets({
      id: 'q',
      section: 'Quality',
      number: '2.01',
      text: 'Describe your approach to EPC assessment at scale, including how you report progress.',
      answerType: 'TEXT',
      mandatory: true,
      passFail: false,
    });
    assert.ok(facets.length >= 2, 'the "including" hinge is a second search');
    assert.ok(facets.some((facet) => /report progress/i.test(facet)));
  });

  it('never marks itself to a floor other than the one the screen prints', async () => {
    // A loop stopping at its own idea of good enough would hand over answers
    // the pack then prints in amber. The marks below are the exact boundary.
    const boundary = {
      COMPLIANCE: GREEN_FLOOR,
      EVIDENCE: GREEN_FLOOR,
      BUYER_RELEVANCE: GREEN_FLOOR,
      SPECIFICITY: GREEN_FLOOR,
      CLARITY_AND_LIMITS: GREEN_FLOOR,
    };
    const adapter = scripted([PLAN, draftReply(['First.']), draftReply(['At the floor.'], { selfScore: boundary }), draftReply(['Never asked for.'])]);
    const { bid, questionId } = await withProvider(adapter);

    await bidEngine.draftAnswer(asDirector(), bid.id, { questionId });

    assert.equal(adapter.seen.length, 3, 'exactly at the floor is good enough, and buying another pass is not');
  });
});
