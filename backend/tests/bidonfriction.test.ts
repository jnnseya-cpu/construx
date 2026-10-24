import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bidEngine from '../src/domain/bidon/engine.ts';
import { asksNothing, looksLikeQuestionSet, questionShape } from '../src/domain/bidon/questionshape.ts';
import { configuredEmbeddingAdapter } from '../src/ai/providers/embedding.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { ROUTES } from '../src/api/routes.ts';
import { write } from '../src/engines/context.ts';
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

let directory: string;
let engagement: engagements.Engagement;
let thornhill: customers.CustomerAccount;
let calder: customers.CustomerAccount;
let policy: evidence.BidOnEvidence;
let theirs: evidence.BidOnEvidence;
let bid: bids.Bid;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-bidon-friction-'));
  // A real store, because the question-shape check reads the document's own
  // text and a hash with nothing behind it refuses earlier.
  platform = new Platform(undefined, new EvidenceStore(join(directory, 'store')));
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

  engagement = engagements.openEngagement(asDirector(), {
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

describe('a document with nothing question-shaped in it', () => {
  /*
   * What this closes, from a live run: somebody with nine filed documents
   * hunting for the questionnaire, one paid model call at a time —
   *
   *   It read EVD-0001 — RFX1000209 App 3 — Schedule of Amendment (8,301
   *   characters). It answered with no questions at all.
   *
   *   It read EVD-0002 — PI and PL (972 characters). It answered with no
   *   questions at all.
   *
   *   It read EVD-0005 — Appendix 2 - JCT MTC 2024 Order Form (5,674
   *   characters). It returned 23 row(s) and none could be used: 23 carried no
   *   question number.
   *
   * Three charges to learn three documents are not questionnaires, which the
   * platform could have seen for nothing in the first two cases.
   */
  it('recognises a question set', () => {
    const questionnaire =
      'Section 4 — Quality\n4.1 Describe your EPC assessment process from instruction to lodgement\n' +
      '4.2 Set out your lone-working arrangements for domestic visits\n' +
      '4.3 Confirm your rates hold for the full term?';
    const shape = questionShape(questionnaire);
    assert.ok(shape.asking >= 3, `lines that begin by asking: ${shape.asking}`);
    assert.ok(looksLikeQuestionSet(shape));
    assert.equal(asksNothing(shape), false);
  });

  it('finds nothing in an insurance certificate', () => {
    // 'PI and PL' in the live run: 972 characters of policy numbers and dates.
    const shape = questionShape(
      'Professional indemnity insurance\nInsurer: Example Mutual\nPolicy number PI/2026/44190\n' +
        'Limit of indemnity GBP 5,000,000 any one claim\nPeriod of insurance 1 April 2026 to 31 March 2027\n',
    );
    assert.ok(asksNothing(shape));
    assert.equal(looksLikeQuestionSet(shape), false);
  });

  it('does not call a contract or a specification a question set', () => {
    /*
     * The first cut of this counted "describe", "provide", "confirm" and
     * "state" anywhere in the text, so a schedule of amendments scored 131, a
     * cost model 32 and a specification 12 — and nine documents out of ten were
     * labelled "looks like a question set", which cost the reader the one thing
     * the label was for.
     *
     * Obligations are written with those verbs. What makes a question is that
     * it *starts* a line and addresses the reader.
     */
    const amendments =
      'Clause 2.3 is deleted and replaced with the following.\n' +
      'The Contractor shall provide a programme within ten days of the Commencement Date.\n' +
      'The Employer shall confirm receipt in writing.\n' +
      'The Contractor shall state the names of all operatives attending site.\n' +
      'Insert new clause 4.7: the Contractor shall provide evidence of insurance.\n';
    const shape = questionShape(amendments);
    assert.equal(looksLikeQuestionSet(shape), false, 'a schedule of amendments is not a questionnaire');

    const specification =
      'Provide and install a new consumer unit to each property.\n' +
      'Remove all redundant cabling and make good.\n' +
      'Provide certification to the Employer on completion.\n';
    // It opens lines with imperatives, as a work description does — but it
    // never addresses the reader, which is what a questionnaire does.
    assert.equal(looksLikeQuestionSet(questionShape(specification)), false, 'a specification is not a questionnaire');
  });

  it('still recognises a questionnaire that numbers nothing', () => {
    // The case the check must not refuse: no numbering, no question marks, and
    // unmistakably a question set.
    const shape = questionShape(
      'Describe your approach to lone working.\nSet out how your certificates are lodged.\n' +
        'Confirm your insurance limits.',
    );
    assert.equal(shape.numbered, 0);
    assert.equal(shape.questions, 0);
    assert.ok(looksLikeQuestionSet(shape), 'it asks, and it addresses the reader');
  });

  /**
   * A filed document with its bytes actually in the store.
   *
   * The check reads the document's own text, so a hash with nothing behind it
   * refuses earlier and for a different reason. Real bytes, hashed the way the
   * platform hashes them, is the only way to exercise the path a person walks.
   */
  const fileWithText = (title: string, text: string, type: evidence.EvidenceType = 'INSURANCE') => {
    const bytes = Buffer.from(text, 'utf8');
    const hash = hashBytes(bytes);
    const item = evidence.fileEvidence(asDirector(), {
      customerAccountId: thornhill.id,
      type,
      title,
      hash,
      ...(type === 'INSURANCE' || type === 'CERTIFICATE' ? { expiresOn: '2027-03-31' } : {}),
    });
    platform.evidence.put(seed.tenantId, hash, bytes, 'text/plain');
    return item;
  };

  it('refuses before calling a vendor, and names the way past itself', async () => {
    // 'PI and PL' in the live run: 972 characters of policy numbers and dates,
    // charged as a model call to discover it is not a questionnaire.
    const nothing = fileWithText(
      'PI and PL',
      'Professional indemnity insurance\nInsurer: Example Mutual\nPolicy number PI/2026/44190\n' +
        'Limit of indemnity GBP 5,000,000 any one claim\nPeriod of insurance 1 April 2026 to 31 March 2027\n',
    );

    // A second bid, because the first has a confirmed question list and the
    // parser refuses one of those for a different and correct reason.
    const second = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'CUSTOM',
      deadline: '2027-09-01',
    });

    const refusal = await rejectsCode(
      () => bidEngine.parseQuestionnaire(asDirector(), platform.evidence, second.id, { hash: nothing.reference }),
      'BID_ON_NOT_A_QUESTION_SET',
    );

    assert.match(refusal.message ?? '', /asks nothing/);
    assert.match(refusal.message ?? '', /nothing has been charged/);
    // The rest of the library, so the next attempt is a choice rather than a
    // guess — and the override, so the check can be argued with.
    assert.match(refusal.message ?? '', new RegExp(policy.reference));
    assert.match(refusal.message ?? '', /anyway/i);
  });

  it('sends it when the person says to, and spends the one call', async () => {
    const nothing = fileWithText(
      'PI and PL, second copy',
      'Insurer: Example Mutual. Policy number PI/2026/44191. Limit of indemnity GBP 5,000,000.\n',
    );
    const third = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'CUSTOM',
      deadline: '2027-10-01',
    });

    // Past the check, into the ordinary refusal for a deployment with no
    // provider — which is the proof that the override reaches the model rather
    // than the check being skipped.
    await rejectsCode(
      () =>
        bidEngine.parseQuestionnaire(asDirector(), platform.evidence, third.id, { hash: nothing.id, anyway: true }),
      'NO_REASONING_PROVIDER',
    );
  });

  it('lets a real question set through without the override', async () => {
    const questionnaire = fileWithText(
      'RFX1000209 Selection Questionnaire',
      'Section 4 — Quality\n4.1 Describe your EPC assessment process from instruction to lodgement\n' +
        '4.2 Set out your lone-working arrangements for domestic visits\n' +
        '4.3 Confirm your rates hold for the full term\n',
      'OTHER',
    );
    const fourth = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'CUSTOM',
      deadline: '2027-11-01',
    });

    // The check is a floor, not a gate: a document with questions in it goes
    // straight to the model, which is refused here only for want of one.
    await rejectsCode(
      () => bidEngine.parseQuestionnaire(asDirector(), platform.evidence, fourth.id, { hash: questionnaire.id }),
      'NO_REASONING_PROVIDER',
    );
  });
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('confirming what the parser proposed', () => {
  /*
   * The path that could not be walked.
   *
   * `confirmQuestions` has always read an empty list as "the parse was right"
   * and confirmed `proposedQuestions`. The route's schema required at least one
   * item, so that branch was unreachable through the API from the day it was
   * written — and nothing noticed, because nothing could reach it: an AI parse
   * needs a provider, so no test had ever produced a proposal to confirm.
   *
   * The symptom, once the console grew a Confirm button under the proposal it
   * now displays, was `request body failed schema validation` on a list the
   * platform had just proposed, parsed and charged for.
   */
  it('accepts an empty list as "the parse was right"', async () => {
    const parsed = [
      {
        section: 'Appendix A: Evaluation Criteria',
        number: '1.1',
        text: 'Please confirm that you hold an approved DEA accreditation, or equivalent.',
        answerType: 'UPLOAD',
        mandatory: true,
      },
      {
        section: 'Appendix F: Form of Tender',
        number: '2.1',
        text: 'Complete the Form of Tender declarations and provide signature, printed name and position.',
        answerType: 'UPLOAD',
        mandatory: true,
      },
    ];

    // A bid carrying a proposal, written through the parser's own event so the
    // state is the state a real parse leaves behind.
    const proposedBid = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
    });
    const ctx = asDirector();
    write(ctx, {
      eventType: 'BID_ON_QUESTIONS_PARSED',
      entity: { refType: 'BidOnBid', refId: proposedBid.id },
      nextState: { ...proposedBid, status: 'PARSING', proposedQuestions: parsed, parsedAt: new Date().toISOString(), parsedBy: 'OPENAI' },
    });

    // Through the route, with the body the console's Confirm button sends —
    // which is where this was refused.
    const confirmed = bids.confirmQuestions(asDirector(), proposedBid.id, { questions: [] });

    assert.equal(confirmed.questions.length, 2);
    assert.deepEqual(
      confirmed.questions.map((entry) => entry.number),
      ['1.1', '2.1'],
      'the buyer’s own numbering, in the order the parser read it',
    );
    assert.ok(confirmed.questionsConfirmedAt);

    // And the route itself accepts that body: the schema used to require at
    // least one item, which is what made the domain branch unreachable.
    const route = ROUTES.find((entry) => entry.method === 'POST' && entry.pattern === '/v1/bid-on/bids/:bidId/questions');
    assert.ok(route, 'the confirm route is registered');
    const questions = (route.schema as { properties?: { questions?: { minItems?: number } } }).properties?.questions;
    assert.equal(questions?.minItems, 0, 'an empty list is a decision, not a missing field');
  });

  it('still refuses an empty confirmation where there is no proposal', () => {
    const bare = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
    });
    // Nothing is loosened by allowing the empty list: confirming nothing is
    // still refused, because there is nothing to confirm.
    throwsCode(() => bids.confirmQuestions(asDirector(), bare.id, { questions: [] }), 'BID_ON_NO_QUESTIONS');
  });
});

/**
 * Thirty-seven questions for one buyer, and the two things the platform made
 * impossible.
 *
 * Reading a schedule of amendments against JCT MTC 2024 raised **thirty-seven**
 * clarifications on the first real tender through here. Both halves of what
 * happens next were unusable:
 *
 *   - The register printed them in the order they were raised, so the first
 *     question anybody has of thirty-seven rows — which cannot be left unasked
 *     — was answered by scanning a badge column. The reader asked it in those
 *     words: *"show me the critical ones"*.
 *   - They go to the buyer as **one** portal message, numbered inside it, and
 *     answered in one response issued to every bidder. Recording that message
 *     meant thirty-seven separate acts, each wanting an id typed in and the
 *     same date typed again — thirty-seven chances to put a different date on
 *     two questions that went in the same email, when the date is the only
 *     thing the record is for.
 *
 * What the platform must not do is send anything: a clarification goes through
 * the buyer's own portal, under a named account, in an audited procurement. So
 * the message is generated and the sending is theirs — and our own severity
 * stays out of the message, because "critical, we cannot price this as it
 * stands" tells a buyer exactly where we are soft.
 */
describe('thirty-seven questions for one buyer', () => {
  let asking: bids.Bid;

  before(() => {
    asking = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
      clarificationDeadline: '2026-10-27',
    });
    // Raised out of severity order on purpose: the order they were raised in
    // is the order that was useless, and it has to be the input here.
    for (const entry of [
      { severity: 'MINOR' as const, subject: 'Format of the cost model', question: 'Should the cost model be returned as the issued spreadsheet or as a PDF of it?' },
      { severity: 'CRITICAL' as const, subject: 'Collateral warranties', question: 'Clause 7 requires collateral warranties to an unnamed class of beneficiary. Who are they and how many?' },
      { severity: 'MAJOR' as const, subject: 'Liquidated damages', question: 'The amendment states liquidated damages at a rate per week with no cap. Will a cap be applied?' },
      { severity: 'CRITICAL' as const, subject: 'Insurance limit', question: 'The amended indemnity is uncapped. Our professional indemnity cover is limited per claim — is that acceptable?' },
      { severity: 'MINOR' as const, subject: 'Site access hours', question: 'Are the stated site access hours the same during the school holidays as in term time?' },
    ]) {
      asking = bids.raiseClarification(asDirector(), asking.id, entry).bid;
    }
  });

  it('puts the worst first, so a list of thirty-seven answers the question anybody has of it', () => {
    const position = bids.bidPosition(asDirector(), asking.id, '2026-10-24');
    assert.deepEqual(
      position.clarifications.map((entry) => entry.severity),
      ['CRITICAL', 'CRITICAL', 'MAJOR', 'MINOR', 'MINOR'],
    );
    // Within a severity, the order they were raised. Not re-sorted by subject:
    // two readers' questions about the same clause belong together.
    assert.deepEqual(
      position.clarifications.filter((entry) => entry.severity === 'CRITICAL').map((entry) => entry.subject),
      ['Collateral warranties', 'Insurance limit'],
    );
  });

  it('renders the message to paste, worst first and numbered', () => {
    const set = bids.clarificationsToSend(asDirector(), asking.id, { asAt: '2026-10-24' });

    assert.equal(set.entries.length, 5);
    assert.deepEqual(set.counts, { critical: 2, major: 1, minor: 2 });
    assert.deepEqual(
      set.entries.map((entry) => entry.position),
      [1, 2, 3, 4, 5],
      'numbered in the order they are printed, because that is what the buyer will answer by',
    );
    assert.equal(set.entries[0]!.subject, 'Collateral warranties');
    // The window, which is the whole reason this is time-critical.
    assert.equal(set.clarificationDeadline, '2026-10-27');
    assert.equal(set.daysToAsk, 3);
    assert.match(set.summary, /3 day\(s\) left to ask/);

    // The message itself: the tender named, every question in it, and our own
    // reference against each one so the buyer's answer leads back to one row.
    assert.match(set.content, /Platform Housing Group — /);
    for (const entry of set.entries) {
      assert.ok(set.content.includes(entry.question), `${entry.subject} is in the message`);
      assert.ok(set.content.includes(entry.id), `${entry.subject} carries our reference`);
    }
    assert.ok(set.content.indexOf('Collateral warranties') < set.content.indexOf('Site access hours'));
  });

  it('keeps our own severity out of the message', () => {
    // The ordering is by severity and the message does not say so. A buyer
    // reading "critical — we cannot price or insure it as it stands" learns
    // exactly where we are soft, and that sentence was written for a colleague.
    const set = bids.clarificationsToSend(asDirector(), asking.id, { asAt: '2026-10-24' });
    for (const word of ['CRITICAL', 'Critical', 'MAJOR', 'Major', 'MINOR', 'Minor']) {
      assert.ok(!set.content.includes(word), `the message does not carry "${word}"`);
    }
  });

  it('sends the critical ones on their own when that is the decision', () => {
    const critical = bids.clarificationsToSend(asDirector(), asking.id, { severity: 'CRITICAL', asAt: '2026-10-24' });
    assert.equal(critical.entries.length, 2);
    assert.deepEqual(critical.counts, { critical: 2, major: 0, minor: 0 });
    assert.deepEqual(critical.entries.map((entry) => entry.position), [1, 2]);
    assert.match(critical.filename, /-critical\.txt$/);
    // And it still says how many are waiting in total, so choosing the two
    // does not hide the other three.
    assert.equal(critical.outstanding, 5);
  });

  it('records the whole message as one act, with one date and one reference', () => {
    const before = platform.ledger.events({}).length;
    const ids = bids.clarificationsToSend(asDirector(), asking.id, { asAt: '2026-10-24' }).entries.map((e) => e.id);

    const recorded = bids.markClarificationsAsked(asDirector(), asking.id, ids, {
      askedOn: '2026-10-24',
      buyerReference: 'PHG-CLAR-014',
    });

    assert.equal(recorded.clarifications.length, 5);
    assert.equal(recorded.late, false);
    assert.equal(recorded.askedOn, '2026-10-24');
    for (const entry of recorded.clarifications) {
      assert.equal(entry.status, 'ASKED');
      assert.equal(entry.askedAt, '2026-10-24', 'one message is one date');
      assert.equal(entry.buyerReference, 'PHG-CLAR-014', 'and one reference');
    }

    // One act, one entry. Thirty-seven entries for one email would be a ledger
    // that reads as thirty-seven things having happened.
    const written = platform.ledger.events({}).slice(before);
    assert.equal(written.length, 1, 'one message to the buyer is one event');
    assert.equal(written[0]!.eventType, 'BID_ON_CLARIFICATION_ASKED');

    // Nothing is left waiting, and the standing says so.
    const after = bids.clarificationsToSend(asDirector(), asking.id, { asAt: '2026-10-24' });
    assert.equal(after.entries.length, 0);
    assert.match(after.summary, /Nothing is waiting to be asked/);
    assert.equal(bids.bidPosition(asDirector(), asking.id, '2026-10-24').clarificationStanding.raised, 0);
  });

  it('refuses the whole set rather than recording part of it', () => {
    let partial = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
      clarificationDeadline: '2026-10-27',
    });
    const first = bids.raiseClarification(asDirector(), partial.id, {
      severity: 'CRITICAL',
      subject: 'Parent company guarantee',
      question: 'Is a parent company guarantee required where the bidder meets the financial thresholds alone?',
    });
    partial = first.bid;
    const second = bids.raiseClarification(asDirector(), partial.id, {
      severity: 'MAJOR',
      subject: 'Retention percentage',
      question: 'The retention percentage in the amendment differs from the one in the order form. Which governs?',
    });
    partial = second.bid;

    // An id that is not on this bid. Recording the other one and reporting a
    // problem with this one would leave nobody able to say which went.
    throwsCode(
      () =>
        bids.markClarificationsAsked(asDirector(), partial.id, [first.clarification.id, 'not-an-id'], {
          askedOn: '2026-10-24',
        }),
      'BID_ON_CLARIFICATION_NOT_FOUND',
    );
    assert.equal(
      bids.bidPosition(asDirector(), partial.id, '2026-10-24').clarificationStanding.raised,
      2,
      'nothing was recorded',
    );

    // Nothing selected is a refusal that names the field, not an empty act.
    throwsCode(
      () => bids.markClarificationsAsked(asDirector(), partial.id, [], { askedOn: '2026-10-24' }),
      'BID_ON_NOTHING_TO_RECORD',
    );

    // One already answered, in a set of two: the same refusal the single path
    // gives, because one offender needs no new wording.
    bids.markClarificationAsked(asDirector(), partial.id, first.clarification.id, { askedOn: '2026-10-24' });
    bids.recordClarificationAnswer(asDirector(), partial.id, first.clarification.id, {
      answer: 'A parent company guarantee is not required where the bidder meets the thresholds in its own right.',
      answeredOn: '2026-10-25',
    });
    throwsCode(
      () =>
        bids.markClarificationsAsked(asDirector(), partial.id, [first.clarification.id, second.clarification.id], {
          askedOn: '2026-10-26',
        }),
      'BID_ON_CLARIFICATION_ANSWERED',
    );
    assert.equal(
      bids.bidPosition(asDirector(), partial.id, '2026-10-26').clarificationStanding.raised,
      1,
      'the second one is still waiting, unrecorded',
    );

    // Two or more offenders get a refusal that names them all, because
    // deselecting them is the next action and a list of one is not enough.
    bids.markClarificationAsked(asDirector(), partial.id, second.clarification.id, { askedOn: '2026-10-26' });
    bids.recordClarificationAnswer(asDirector(), partial.id, second.clarification.id, {
      answer: 'The retention percentage stated in the schedule of amendments governs over the order form.',
      answeredOn: '2026-10-27',
    });
    const refusal = throwsCode(
      () =>
        bids.markClarificationsAsked(asDirector(), partial.id, [first.clarification.id, second.clarification.id], {
          askedOn: '2026-10-28',
        }),
      'BID_ON_CLARIFICATIONS_NOT_ASKABLE',
    );
    assert.match(refusal.message ?? '', /Parent company guarantee/);
    assert.match(refusal.message ?? '', /Retention percentage/);
  });

  it('records a late set as late rather than refusing it', () => {
    let late = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
      clarificationDeadline: '2026-10-27',
    });
    const raised = bids.raiseClarification(asDirector(), late.id, {
      severity: 'MINOR',
      subject: 'Bid bond wording',
      question: 'Is the bid bond wording in appendix 6 negotiable, or is it issued on a take-it-or-leave-it basis?',
    });
    late = raised.bid;

    // After the window. A fact, and often one worth having: a buyer may answer
    // a late question and may not. Refusing it would make the honest entry
    // impossible and leave the question looking un-asked for ever.
    const recorded = bids.markClarificationsAsked(asDirector(), late.id, [raised.clarification.id], {
      askedOn: '2026-10-29',
    });
    assert.equal(recorded.late, true);
    assert.equal(recorded.clarifications[0]!.status, 'ASKED');
  });

  it('routes both halves, and the read is a read', () => {
    const send = ROUTES.find(
      (entry) => entry.method === 'GET' && entry.pattern === '/v1/bid-on/bids/:bidId/clarifications/to-send',
    );
    assert.ok(send, 'the message is reachable');
    assert.equal(send.readOnly, true, 'generating the message records nothing');

    const asked = ROUTES.find(
      (entry) => entry.method === 'POST' && entry.pattern === '/v1/bid-on/bids/:bidId/clarifications/asked',
    );
    assert.ok(asked, 'the bulk record is routed');
    const ids = (asked.schema as { properties?: { clarificationIds?: { minItems?: number; maxItems?: number } } })
      .properties?.clarificationIds;
    assert.equal(ids?.minItems, 1, 'an empty set is nothing having happened');
    assert.ok((ids?.maxItems ?? 0) >= 200, 'a schedule of amendments raises dozens at once');

    // The single path is untouched: one question asked on its own still works,
    // and still carries its own date.
    const one = ROUTES.find(
      (entry) =>
        entry.method === 'POST' && entry.pattern === '/v1/bid-on/bids/:bidId/clarifications/:clarificationId/asked',
    );
    assert.ok(one, 'recording one question on its own is still routed');
  });
});

/**
 * The yes/no question the drafter could never answer.
 *
 * `recordAnswer` refuses an answer to a `YES_NO` question that carries no
 * `yesNo`, and it is right to: the hard rule that ends a bid on a "no" reads
 * that field, and prose saying "we do not hold ISO 14001" leaves the check
 * seeing an unanswered question.
 *
 * The drafter never asked the model for the field and never passed one on. So
 * **every yes/no question in the catalogue called a vendor, was charged for the
 * call, built the answer and was refused on the last line** — money spent,
 * nothing recorded, and the refusal talking about a field the person had no way
 * to set from the panel they were in.
 *
 * It is the same shape as the three before it: an AI success path that cannot
 * run without a live model, and had therefore never run. What is testable here
 * without a vendor is the half that a vendor's variety actually breaks — how a
 * `yes` comes back — and the rule that nothing is guessed. The end-to-end draft
 * of a yes/no question **cannot be exercised in this environment**: it needs a
 * live provider, and this suite has none.
 */
describe('the yes or the no a model sends back', () => {
  it('reads a boolean, which is what the schema asks for', () => {
    assert.equal(bidEngine.yesNoFrom(true), true);
    assert.equal(bidEngine.yesNoFrom(false), false);
  });

  it('reads the words a vendor sends instead, in whatever case', () => {
    // Refusing these would throw away a perfectly good answer and charge for
    // the retry.
    for (const yes of ['yes', 'Yes', 'YES', ' y ', 'true', 'True']) {
      assert.equal(bidEngine.yesNoFrom(yes), true, `"${yes}" is a yes`);
    }
    for (const no of ['no', 'No', 'NO', 'n', 'false', 'False']) {
      assert.equal(bidEngine.yesNoFrom(no), false, `"${no}" is a no`);
    }
  });

  it('guesses nothing, because a bid ends at the gate on a no', () => {
    // Each of these is a model declining to answer the question as asked. The
    // platform does not resolve any of them on a bidder's behalf: a wrong yes
    // is a representation to a buyer that the company cannot stand behind.
    for (const unclear of ['maybe', 'see our answer', 'partially', 'yes, subject to survey', '', 1, 0, null, undefined, {}, ['yes']]) {
      assert.equal(bidEngine.yesNoFrom(unclear), undefined, `${JSON.stringify(unclear)} is not an answer`);
    }
  });

  it('is what a yes/no answer needs, and prose alone is still refused', () => {
    // The rule the drafter now satisfies, asserted from the other side: this is
    // what the refusal on the last line was, and it stays exactly as it was for
    // a hand-written answer.
    let yesNoBid = bids.createBid(asDirector(), {
      engagementId: engagement.id,
      buyerName: 'Platform Housing Group',
      scheme: 'ITT',
      deadline: '2026-11-02',
    });
    yesNoBid = bids.confirmQuestions(asDirector(), yesNoBid.id, {
      questions: [
        {
          section: 'Central Digital Platform',
          number: '1.2',
          text: 'Are you registered on the Central Digital Platform?',
          answerType: 'YES_NO',
          mandatory: true,
        },
      ],
    });
    const question = yesNoBid.questions[0]!;

    throwsCode(
      () =>
        bids.recordAnswer(asWriter(), yesNoBid.id, {
          questionId: question.id,
          body: ['We are registered on the Central Digital Platform.'],
          authorship: 'HUMAN',
        }),
      'BID_ON_YES_NO_REQUIRED',
    );

    const written = bids.recordAnswer(asWriter(), yesNoBid.id, {
      questionId: question.id,
      body: ['We are registered on the Central Digital Platform.'],
      yesNo: true,
      authorship: 'HUMAN',
    });
    assert.equal(written.answer.yesNo, true);
  });
});
