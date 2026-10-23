import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bidEngine from '../src/domain/bidon/engine.ts';
import { configuredEmbeddingAdapter } from '../src/ai/providers/embedding.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Four refusals a person met while running a real tender, and what each one
 * was really saying.
 *
 * The customer's instruction was "fix them all", and the right answer is
 * different for each, so this file is the record of which is which:
 *
 *   1. **`BID_ON_EVIDENCE_NOT_FOUND`** — pure friction. A library row carries
 *      an id, a reference and a content hash, six commands took only the id,
 *      and the refusal *explained* the difference instead of resolving it. The
 *      platform holds all three values. It now accepts any of them.
 *   2. **`BID_ON_GAP_OPEN`** — a good rule enforced as a wall. Drafting over an
 *      open gap spends money writing around what is missing, which is a
 *      judgement the person with the deadline is entitled to make. It is now a
 *      choice they take explicitly, and the answer carries the gap.
 *   3. **`BID_ON_NOT_EXPORTABLE`** — the gate is right and it was stopping the
 *      wrong thing. Reviewing a pack is how it gets finished; the only way to
 *      read one used to be to finish it first. A review copy renders, marked.
 *   4. **`BID_ON_SELF_APPROVAL`** — not friction. The two-person check is the
 *      whole value of the module and it stays. What changed is that the
 *      refusal names the three ways on, one of which nobody would guess.
 *
 * And the fifth, met on the same run: `AI_EMBEDDING_NOT_CONFIGURED` on a
 * deployment whose vendor key works for everything else.
 */

let platform: Platform;
let seed: SeedResult;

const asDirector = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const HASH = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;

let thornhill: customers.CustomerAccount;
let calder: customers.CustomerAccount;
let policy: evidence.BidOnEvidence;
let theirs: evidence.BidOnEvidence;
let bid: bids.Bid;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });

  thornhill = customers.openCustomer(asDirector(), { legalName: 'Thornhill Electrical Services Ltd' });
  calder = customers.openCustomer(asDirector(), { legalName: 'Calder Civils Ltd' });
  customers.assignStaff(asDirector(), thornhill.id, { add: [asWriter().auth.actorId] });

  const engagement = engagements.openEngagement(asDirector(), {
    customerAccountId: thornhill.id,
    name: 'UVDB prequalification',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asDirector(), engagement.id);

  policy = evidence.fileEvidence(asDirector(), {
    customerAccountId: thornhill.id,
    type: 'POLICY',
    title: 'Health and safety policy 2026',
    hash: HASH('a'),
  });
  policy = evidence.recordExtraction(asDirector(), policy.id, {
    extractedText: ['Our health and safety policy is reviewed annually by the board.'],
    chunks: [
      {
        pageRef: 'page 4',
        text:
          'Every operative holds a current ECS card and every site has a nominated first aider. Accident ' +
          'statistics are reported to the board quarterly and to our clients on request.',
      },
    ],
  });

  // Another customer's document, for the visibility rules below. The writer is
  // assigned to Thornhill and not to Calder.
  theirs = evidence.fileEvidence(asDirector(), {
    customerAccountId: calder.id,
    type: 'POLICY',
    title: 'Calder health and safety policy',
    hash: HASH('b'),
  });

  bid = bids.createBid(asDirector(), {
    engagementId: engagement.id,
    buyerName: 'Yorkshire Water Services Limited',
    scheme: 'UVDB',
    deadline: '2027-06-01',
  });
  bid = bids.confirmQuestions(asDirector(), bid.id, {
    questions: [
      {
        section: 'HSEQ',
        number: '4.1',
        text: 'Describe your health and safety management arrangements and how accident statistics are reported',
        answerType: 'TEXT',
        wordLimit: 500,
        mandatory: true,
      },
      {
        section: 'Commercial',
        number: '5.1',
        text: 'Confirm your rates hold for the full term of the framework',
        answerType: 'TEXT',
        mandatory: true,
      },
    ],
  });
});

describe('a document is whatever the person actually copied', () => {
  it('takes the id, as it always did', () => {
    assert.equal(evidence.requireEvidence(asDirector(), policy.id).reference, policy.reference);
  });

  it('takes the content hash, which used to be refused with an explanation', () => {
    // The refusal that sent somebody looking for an upload that had worked
    // perfectly: "No evidence sha256:309b…". The platform holds the hash on the
    // record it is being asked about.
    const found = evidence.requireEvidence(asDirector(), policy.hash);
    assert.equal(found.id, policy.id);
  });

  it('takes the reference, which is the value printed largest on the row', () => {
    assert.equal(evidence.requireEvidence(asDirector(), policy.reference).id, policy.id);
    // Case is not a thing anybody should have to get right in a reference.
    assert.equal(evidence.requireEvidence(asDirector(), policy.reference.toLowerCase()).id, policy.id);
  });

  it('refuses to guess when one document is filed for two customers', async () => {
    // A hash is the address of *contents*, and two customers can file the same
    // standard certificate. Resolving it to whichever came first would act on
    // one customer's record while somebody was looking at another's.
    const alsoTheirs = evidence.fileEvidence(asDirector(), {
      customerAccountId: calder.id,
      type: 'POLICY',
      title: 'Thornhill policy, filed to the wrong customer',
      hash: policy.hash,
    });

    const refusal = throwsCode(
      () => evidence.requireEvidence(asDirector(), policy.hash),
      'BID_ON_EVIDENCE_AMBIGUOUS',
    );
    assert.match(refusal.message ?? '', new RegExp(policy.reference));
    assert.match(refusal.message ?? '', new RegExp(alsoTheirs.reference));

    // And the ids still resolve, so the way out of the ambiguity is the one the
    // refusal names.
    assert.equal(evidence.requireEvidence(asDirector(), policy.id).id, policy.id);
    evidence.withdrawEvidence(asDirector(), alsoTheirs.id, { reason: 'Filed against the wrong customer' });
  });

  it('says what it is when nothing matches, and names all three ways in', () => {
    const refusal = throwsCode(() => evidence.requireEvidence(asDirector(), 'EVD-9999'), 'BID_ON_EVIDENCE_NOT_FOUND');
    assert.match(refusal.message ?? '', /id, its reference \(EVD-0001\) and its document hash all work/);
  });

  it('does not resolve another customer’s document for somebody not assigned to it', () => {
    /*
     * The whole reason the lookup exists: an identifier is a value a caller
     * could hold from anywhere, and a provider's customers compete with each
     * other.
     *
     * Two different refusals, and both are honest. An **id** resolves to a
     * record and then fails the assignment check, which is a denial —
     * `BID_ON_CUSTOMER_NOT_ASSIGNED`, 403. A **reference** or a **hash** is
     * resolved by searching what this person may see, so there is nothing to
     * deny: it is simply not in their library. Neither route hands over the
     * document, which is the property that matters.
     */
    throwsCode(() => evidence.requireEvidence(asWriter(), theirs.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');
    throwsCode(() => evidence.requireEvidence(asWriter(), theirs.reference), 'BID_ON_EVIDENCE_NOT_FOUND');
    throwsCode(() => evidence.requireEvidence(asWriter(), theirs.hash), 'BID_ON_EVIDENCE_NOT_FOUND');
  });

  it('lists every document a person may see, and nobody else’s', () => {
    const mine = evidence.visibleEvidence(asWriter());
    const references = mine.evidence.map((item) => item.reference);
    assert.ok(references.includes(policy.reference), 'the customer they are assigned to');
    assert.ok(!references.includes(theirs.reference), 'and not the one they are not');
    // What a chooser needs to show before somebody presses a button: an item
    // with nothing read out of it cannot be embedded or cited.
    assert.equal(mine.evidence.find((item) => item.reference === policy.reference)?.read, true);
  });
});

describe('a question waiting on the customer', () => {
  it('refuses to draft over an open gap, and names the way on', async () => {
    const question = bid.questions.find((entry) => entry.number === '5.1')!;
    bids.raiseGap(asDirector(), bid.id, {
      questionId: question.id,
      promptToClient: 'Please send your current rate schedule for the third-floor walk-ups.',
    });

    const refusal = await rejectsCode(
      () => bidEngine.draftAnswer(asDirector(), bid.id, { questionId: question.id }),
      'BID_ON_GAP_OPEN',
    );
    // The two ways out, in the refusal rather than in somebody's memory.
    assert.match(refusal.message ?? '', /close the gap/);
    assert.match(refusal.message ?? '', /draft over it/);
  });

  it('drafts over it when the person says to, and the answer carries the gap', async () => {
    /*
     * Asserted against the question that *has* evidence, because the proof
     * wanted here is that the command reached the model.
     *
     * There is no AI provider configured in a test, so it then refuses by name:
     * `NO_REASONING_PROVIDER` means retrieval ran, found passages, and asked
     * for a model — so the open gap is no longer what stops the command. On the
     * question with no evidence the drafter raises a gap instead of drafting,
     * which is a different rule and is tested elsewhere.
     */
    const question = bid.questions.find((entry) => entry.number === '4.1')!;
    bids.raiseGap(asDirector(), bid.id, {
      questionId: question.id,
      promptToClient: 'Please send the board minutes recording the quarterly accident report.',
    });

    await rejectsCode(
      () => bidEngine.draftAnswer(asDirector(), bid.id, { questionId: question.id }),
      'BID_ON_GAP_OPEN',
    );
    const refusal = await rejectsCode(
      () => bidEngine.draftAnswer(asDirector(), bid.id, { questionId: question.id, overOpenGap: true }),
      'NO_REASONING_PROVIDER',
    );
    assert.doesNotMatch(refusal.message ?? '', /gap/i, 'the gap is no longer what stops it');

    // The field is carried through to the answer by `recordAnswer`, which is
    // the door both the drafter and a person write through. Asserted there,
    // because that is where a reviewer reads it from.
    const written = bids.recordAnswer(asWriter(), bid.id, {
      questionId: question.id,
      body: ['Our rates hold for the full term, subject to the schedule being confirmed.'],
      draftedOverGap: { gapId: 'gap-1', prompt: 'Please send your current rate schedule.' },
    });
    assert.equal(written.answer.draftedOverGap?.gapId, 'gap-1');
    assert.match(written.answer.draftedOverGap?.prompt ?? '', /rate schedule/);
  });
});

describe('a pack that cannot be sent can still be read', () => {
  it('refuses a submission render and offers the review copy in the same breath', () => {
    const refusal = throwsCode(
      () => bids.renderPack(asDirector(), bid.id, 'TEXT', platform.exports.branding(seed.tenantId)),
      'BID_ON_NOT_EXPORTABLE',
    );
    assert.match(refusal.message ?? '', /review copy/);
    // Every blocking item named, because fixing them one attempt at a time is
    // how somebody decides at 4pm that the check is the problem.
    assert.match(refusal.message ?? '', /4\.1/);
  });

  it('renders the review copy, marked, with what is outstanding on it', () => {
    const pack = bids.renderPack(asDirector(), bid.id, 'TEXT', platform.exports.branding(seed.tenantId), {
      review: true,
    });

    assert.equal(pack.review, true);
    assert.ok((pack.outstanding ?? []).length > 0);
    assert.match(pack.filename, /^REVIEW-/, 'a file on somebody’s desktop cannot be mistaken for the submission');
    assert.match(pack.content, /REVIEW COPY — NOT FOR SUBMISSION/);
    // The questions are still there in the buyer's own order: it is the pack,
    // not a status page.
    assert.match(pack.content, /4\.1 Describe your health and safety/);
  });

  it('renders a spreadsheet and a Word copy the same way', () => {
    const branding = platform.exports.branding(seed.tenantId);
    for (const format of ['XLSX', 'DOCX'] as const) {
      const pack = bids.renderPack(asDirector(), bid.id, format, branding, { review: true });
      assert.equal(pack.review, true);
      assert.match(pack.filename, /^REVIEW-/, format);
      assert.ok(pack.content.length > 0, format);
    }
  });
});

describe('the two-person check is not friction, and says what to do', () => {
  it('still refuses one person writing and approving the same answer', () => {
    /*
     * Written by the **director**, because they are the identity that holds
     * approval at all — a bid writer trying to approve is refused on the
     * permission (`ACCESS_DENIED`) long before this rule is reached, and the
     * console does not show them the control. The case this rule exists for is
     * the one person who *can* approve doing both halves.
     */
    const question = bid.questions.find((entry) => entry.number === '5.1')!;
    const written = bids.recordAnswer(asDirector(), bid.id, {
      questionId: question.id,
      body: ['Our rates hold for the full term of the framework, as set out in the schedule.'],
    });

    const refusal = throwsCode(
      () => bids.approveAnswer(asDirector(), bid.id, written.answer.id, { note: 'Signing off my own work here' }),
      'BID_ON_SELF_APPROVAL',
    );

    // All three ways on, including the one nobody would guess: this rule
    // applies to an answer a *person* wrote, so an agent's draft that the same
    // person reviews and signs is already the two-person check.
    assert.match(refusal.message ?? '', /have the director approve it/);
    assert.match(refusal.message ?? '', /agent drafting and a person signing/);
    assert.match(refusal.message ?? '', /somebody else rewrite it/);
  });
});

describe('semantic search is on where a vendor is configured', () => {
  /** Set config for the duration of a block and put back whatever was there. */
  const withConfig = <T>(values: Record<string, string>, run: () => T): T => {
    const held = Object.fromEntries(Object.keys(values).map((key) => [key, (config.ai as never as Record<string, string>)[key]]));
    Object.assign(config.ai as never as Record<string, string>, values);
    try {
      return run();
    } finally {
      Object.assign(config.ai as never as Record<string, string>, held);
    }
  };

  it('uses the vendor that is already configured when nothing names one', () => {
    /*
     * The refusal met on a live run:
     *
     *     AI_EMBEDDING_NOT_CONFIGURED — Semantic search is off on this
     *     deployment: no embedding provider is configured.
     *
     * …on a deployment whose OpenAI key was answering every other AI call. The
     * reason given for the blank default was that defaulting it would mean
     * "every deployment silently started spending the moment a key was set for
     * something else" — and nothing on this platform embeds automatically.
     * Every path is a command somebody presses with the price on screen first.
     */
    const adapter = withConfig(
      { embeddingProvider: '', openaiKey: 'test-key-not-a-real-credential', mode: 'staging' },
      () => configuredEmbeddingAdapter(),
    );
    assert.equal(adapter?.name, 'OPENAI');
  });

  it('is off where the operator says off, which blank used to mean', () => {
    for (const asked of ['off', 'OFF', 'none', 'no']) {
      const adapter = withConfig(
        { embeddingProvider: asked, openaiKey: 'test-key-not-a-real-credential', mode: 'staging' },
        () => configuredEmbeddingAdapter(),
      );
      assert.equal(adapter, undefined, asked);
    }
  });

  it('honours a named vendor, and does not quietly substitute another', () => {
    // An operator who asked for Gemini is told Gemini is unconfigured rather
    // than handed OpenAI's vectors in a space nothing else is in.
    const adapter = withConfig(
      { embeddingProvider: 'GEMINI', openaiKey: 'test-key-not-a-real-credential', geminiKey: '', mode: 'staging' },
      () => configuredEmbeddingAdapter(),
    );
    assert.equal(adapter?.name, 'GEMINI', 'named, and reported as unhealthy rather than replaced');
    assert.equal(adapter?.healthy(), false, 'no key, so it is unhealthy — which is a different fact from absent');
  });

  it('stays off on a local deployment, where there is nothing to call', () => {
    const adapter = withConfig(
      { embeddingProvider: '', openaiKey: 'test-key-not-a-real-credential', mode: 'local' },
      () => configuredEmbeddingAdapter(),
    );
    assert.equal(adapter, undefined);
  });
});
