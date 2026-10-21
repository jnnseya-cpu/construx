import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as carry from '../src/domain/bidon/carryforward.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { CriterionScores } from '../src/domain/bidon/rubric.ts';

/**
 * Carrying a PQQ's approved answers forward into the ITT that follows it.
 *
 * ## The problem
 *
 * A PQQ asks "describe your health and safety management arrangements". Eight
 * weeks later the ITT for the same job asks "set out your health and safety
 * management system". It is the same answer, a person already approved it, and
 * the alternative to finding it is writing it again — which costs a draft, a
 * review, and produces a second version of the company's position that may not
 * match the first. A buyer who reads both documents is entitled to notice.
 *
 * ## The rule this suite exists to hold
 *
 * **It offers and it does not paste.** The last test here reads
 * `carryforward.ts`'s own source and asserts the absence of anything that would
 * write an answer. An absence cannot be exercised by calling it, so it is
 * checked the only way an absence can be.
 *
 * Reuse goes through `recordAnswer` with a `carriedFrom`, which means the same
 * citation check, the same versioning and the same review state as a fresh
 * answer — and the lineage ends up on the record rather than in somebody's
 * memory.
 */

const REPO_ROOT = (() => {
  // From backend/tests up to the repository root, the same way answers.test.ts
  // locates the file whose absence it is asserting.
  let dir = dirname(new URL(import.meta.url).pathname);
  while (!dir.endsWith('construx') && dir !== '/') dir = dirname(dir);
  return dir;
})();

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const REASONS: Record<string, string> = {
  COMPLIANCE: 'Every part of the question is answered in the order asked',
  EVIDENCE: 'Each claim is cited to an in-date item',
  BUYER_RELEVANCE: 'Framed for a utilities buyer and the scheme',
  SPECIFICITY: 'Names the scheme, the figures and the dates',
  CLARITY_AND_LIMITS: 'Inside the word limit and plainly written',
};

const FULL: CriterionScores = {
  COMPLIANCE: 90,
  EVIDENCE: 90,
  BUYER_RELEVANCE: 90,
  SPECIFICITY: 90,
  CLARITY_AND_LIMITS: 90,
};

/** The wording a PQQ uses, and the wording the ITT uses for the same thing. */
const PQQ_WORDING = 'Describe your health and safety management arrangements for site operations.';
const ITT_WORDING = 'Set out your health and safety management arrangements for site operations.';
const UNRELATED = 'State your approach to reducing diesel plant emissions on site.';

let customer: customers.CustomerAccount;
let rival: customers.CustomerAccount;
let engagement: engagements.Engagement;
let rivalEngagement: engagements.Engagement;
let policy: evidence.BidOnEvidence;
let certificate: evidence.BidOnEvidence;

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

  customer = customers.openCustomer(asProviderAdmin(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
  engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: customer.id,
    name: 'Framework, both stages',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 300_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);

  rival = customers.openCustomer(asProviderAdmin(), { legalName: 'Calder Civils Ltd' });
  rivalEngagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: rival.id,
    name: 'Same framework, other side',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), rivalEngagement.id);

  policy = evidence.recordExtraction(
    asProviderAdmin(),
    evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: customer.id,
      type: 'POLICY',
      title: 'Health and safety policy 2027',
      hash: `sha256:${'a'.repeat(64)}`,
    }).id,
    {
      extractedText: ['Our health and safety policy is reviewed annually by the board.'],
      chunks: [
        {
          pageRef: 'page 4',
          text:
            'Every operative holds a current ECS card and every site has a nominated first aider. Accident ' +
            'statistics are reported to the board quarterly and to our clients on request.',
        },
      ],
    },
  );

  // Current when the PQQ was answered, lapsed by the time the ITT is read.
  certificate = evidence.recordExtraction(
    asProviderAdmin(),
    evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: customer.id,
      type: 'CERTIFICATE',
      title: 'SMSTS certificate for the contracts manager',
      hash: `sha256:${'b'.repeat(64)}`,
      expiresOn: '2027-04-30',
    }).id,
    {
      extractedText: ['SMSTS valid to 30 April 2027.'],
      chunks: [{ pageRef: 'page 1', text: 'Site Management Safety Training Scheme certificate, valid to 30 April 2027.' }],
    },
  );
});

/** A won PQQ with one approved answer citing the policy. */
function wonPqq(): { bid: bids.Bid; answerId: string; questionId: string } {
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'National Grid Electricity Transmission',
    scheme: 'SQ_PA23',
    stage: 'PQQ',
    deadline: '2027-03-01',
  });
  bids.confirmQuestions(asProviderAdmin(), bid.id, {
    questions: [
      {
        section: 'Health and safety',
        number: 'Q7',
        text: PQQ_WORDING,
        answerType: 'TEXT',
        wordLimit: 500,
        mandatory: true,
        passFail: false,
      },
    ],
  });
  const question = bids.requireBid(asProviderAdmin(), bid.id).questions[0]!;
  const written = bids.recordAnswer(asBidWriter(), bid.id, {
    questionId: question.id,
    body: [
      'Every operative holds a current ECS card and every site has a nominated first aider.',
      'Accident statistics are reported to our board quarterly and to clients on request.',
    ],
    citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
  });
  bids.scoreAnswer(asProviderAdmin(), bid.id, written.answer.id, { scores: FULL, reasons: REASONS });
  bids.approveAnswer(asProviderAdmin(), bid.id, written.answer.id, {
    note: 'Read against the policy on file; the card requirement and the reporting both check out.',
  });
  return { bid: bids.requireBid(asProviderAdmin(), bid.id), answerId: written.answer.id, questionId: question.id };
}

/** The ITT that follows it, with the same question in the buyer's new words. */
function followingItt(
  followsBidId: string,
  text = ITT_WORDING,
  wordLimit?: number,
  // The section counts towards the wording match, because two questions in one
  // section are genuinely more likely to be the same question. So an
  // "unrelated" fixture has to have an unrelated section too, or it matches on
  // the heading alone — which this suite found the hard way.
  section = 'Health and safety',
): { bid: bids.Bid; questionId: string } {
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'National Grid Electricity Transmission',
    scheme: 'ITT',
    followsBidId,
    deadline: '2027-06-01',
  });
  bids.confirmQuestions(asProviderAdmin(), bid.id, {
    questions: [
      {
        section,
        number: '4.1',
        text,
        answerType: 'TEXT',
        ...(wordLimit === undefined ? {} : { wordLimit }),
        mandatory: true,
        passFail: false,
      },
    ],
  });
  return { bid: bids.requireBid(asProviderAdmin(), bid.id), questionId: bids.requireBid(asProviderAdmin(), bid.id).questions[0]!.id };
}

describe('it is wired in as two reads that write nothing', () => {
  it('routes the board and the candidates, both read-only', () => {
    for (const pattern of [
      '/v1/bid-on/bids/:bidId/carry-forward',
      '/v1/bid-on/bids/:bidId/questions/:questionId/prior-answers',
    ]) {
      const route = ROUTES.find((entry) => entry.method === 'GET' && entry.pattern === pattern);
      assert.ok(route, `GET ${pattern} has no route`);
      assert.equal(route.readOnly, true);
      // Not an AI route: matching one question's wording against another's
      // costs nothing, and a read that spent would be a screen billing
      // somebody for scrolling.
      assert.equal(route.ai, undefined);
    }
  });
});

describe('the PQQ answer is offered against the ITT question', () => {
  it('finds it across the reworded question, and marks the lineage', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);

    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    // The lineage answer is the one offered first, which is the behaviour that
    // matters. Asserting a total would be asserting how many other bids this
    // customer happens to have.
    const candidate = offer.candidates[0]!;
    assert.equal(candidate.answerId, first.answerId);
    assert.equal(candidate.bidReference, first.bid.reference);
    assert.equal(candidate.stage, 'PQQ');
    // The thing that makes this carry-forward rather than a generic library.
    assert.equal(candidate.fromLineage, true);
    assert.equal(candidate.question.number, 'Q7');
    assert.ok(candidate.match >= carry.MINIMUM_CARRY_MATCH);
    assert.equal(candidate.score, 90);
    assert.match(offer.note, /prequalification this bid follows are first/);
  });

  it('offers nothing for a question the earlier pack does not cover', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id, UNRELATED, undefined, 'Environment and carbon');

    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    assert.deepEqual(offer.candidates, []);
    assert.ok(offer.considered > 0, 'it looked at the approved answers and judged them too far off');
    // A loosely matched prior answer is a finished, confident answer to a
    // different question, and the instinct is to use what is offered.
    assert.match(offer.note, /instinct is to use what is offered/);
  });

  it('offers only approved answers, not drafts and not rejected ones', () => {
    const first = wonPqq();
    // A second question on the PQQ, answered but never approved.
    const extra = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: '2027-05-01',
    });
    bids.confirmQuestions(asProviderAdmin(), extra.id, {
      questions: [
        { section: 'Health and safety', number: 'A1', text: PQQ_WORDING, answerType: 'TEXT', mandatory: true, passFail: false },
      ],
    });
    const question = bids.requireBid(asProviderAdmin(), extra.id).questions[0]!;
    bids.recordAnswer(asBidWriter(), extra.id, {
      questionId: question.id,
      body: ['A draft nobody has approved.'],
      citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
    });

    const second = followingItt(first.bid.id);
    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    // A draft is not a prior answer, and a rejected one is a prior answer
    // somebody decided against. Both absent; the approved one present.
    const draftId = bids.requireBid(asProviderAdmin(), extra.id).answers[0]!.id;
    assert.ok(offer.candidates.every((entry) => entry.answerId !== draftId));
    assert.ok(offer.candidates.some((entry) => entry.answerId === first.answerId));
  });

  it('never offers another customer’s answer, however well it matches', () => {
    // The rival's answer to the identical question, approved.
    const theirs = bids.createBid(asProviderAdmin(), {
      engagementId: rivalEngagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'SQ_PA23',
      stage: 'PQQ',
      deadline: '2027-03-01',
    });
    bids.confirmQuestions(asProviderAdmin(), theirs.id, {
      questions: [
        { section: 'Health and safety', number: 'Q7', text: PQQ_WORDING, answerType: 'TEXT', mandatory: true, passFail: false },
      ],
    });
    const theirQuestion = bids.requireBid(asProviderAdmin(), theirs.id).questions[0]!;
    const theirEvidence = evidence.recordExtraction(
      asProviderAdmin(),
      evidence.fileEvidence(asProviderAdmin(), {
        customerAccountId: rival.id,
        type: 'POLICY',
        title: 'Their health and safety policy',
        hash: `sha256:${'c'.repeat(64)}`,
      }).id,
      { extractedText: ['Their policy.'], chunks: [{ text: 'Their own health and safety arrangements, in their own words.' }] },
    );
    // Assigned to both, which makes the test stronger rather than weaker: even
    // where one person can see both customers, the offer never crosses.
    customers.assignStaff(asProviderAdmin(), rival.id, { add: [asBidWriter().auth.actorId] });
    const theirAnswer = bids.recordAnswer(asBidWriter(), theirs.id, {
      questionId: theirQuestion.id,
      body: ['Their arrangements, which are none of this customer’s business.'],
      citations: [{ evidenceId: theirEvidence.id, chunkId: theirEvidence.chunks[0]!.id }],
    });
    bids.scoreAnswer(asProviderAdmin(), theirs.id, theirAnswer.answer.id, { scores: FULL, reasons: REASONS });
    bids.approveAnswer(asProviderAdmin(), theirs.id, theirAnswer.answer.id, {
      note: 'Read against their own policy; it answers what was asked.',
    });

    const first = wonPqq();
    const second = followingItt(first.bid.id);
    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);

    // Two customers of one provider chase the same framework. This is the one
    // failure the module exists to prevent, and it would arrive dressed as a
    // convenience.
    assert.ok(offer.candidates.every((entry) => entry.bidId !== theirs.id));
    assert.ok(offer.candidates.every((entry) => entry.answerId !== theirAnswer.answer.id));
  });
});

describe('it checks the two things reading an old pack by hand would miss', () => {
  it('re-checks every citation against this bid’s date', () => {
    const first = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'SQ_PA23',
      stage: 'PQQ',
      deadline: '2027-03-01',
    });
    bids.confirmQuestions(asProviderAdmin(), first.id, {
      questions: [
        { section: 'Health and safety', number: 'Q7', text: PQQ_WORDING, answerType: 'TEXT', mandatory: true, passFail: false },
      ],
    });
    const question = bids.requireBid(asProviderAdmin(), first.id).questions[0]!;
    // Cites a certificate that lapses on 30 April — after the PQQ's return and
    // before the ITT's.
    const written = bids.recordAnswer(asBidWriter(), first.id, {
      questionId: question.id,
      body: ['Our contracts manager holds a current SMSTS certificate.'],
      citations: [{ evidenceId: certificate.id, chunkId: certificate.chunks[0]!.id }],
    });
    bids.scoreAnswer(asProviderAdmin(), first.id, written.answer.id, { scores: FULL, reasons: REASONS });
    bids.approveAnswer(asProviderAdmin(), first.id, written.answer.id, {
      note: 'Read against the certificate; it is current on the day this PQQ is returned.',
    });

    const second = followingItt(first.id);
    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    const candidate = offer.candidates.find((entry) => entry.answerId === written.answer.id)!;

    // Approved in March citing something that lapsed in April, offered against
    // a June return. Nothing about reading the prose would tell you.
    assert.equal(candidate.citationsCurrent, false);
    assert.equal(candidate.citations[0]?.current, false);
    assert.equal(candidate.citations[0]?.expiresOn, '2027-04-30');
    assert.ok(offer.limits.some((line) => /not current on 2027-06-01/.test(line)));
  });

  it('says where a candidate is longer than this question’s limit', () => {
    const first = wonPqq();
    // The ITT allows ten words; the PQQ answer is far longer.
    const second = followingItt(first.bid.id, ITT_WORDING, 10);
    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    const candidate = offer.candidates[0]!;

    assert.equal(candidate.withinLimit, false);
    // Still offered: it is a starting point, and saying so is the difference
    // between a useful offer and a trap.
    assert.ok(candidate.words > 10);
    assert.ok(offer.limits.some((line) => /longer than this question's 10-word limit/.test(line)));
  });

  it('reports null rather than true where the question states no limit', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);
    const candidate = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId).candidates[0]!;
    // Unknown is not the same as fine, and a boolean would have had to lie.
    assert.equal(candidate.withinLimit, null);
  });
});

describe('the board says where to start', () => {
  it('counts candidates per question and names the pack it follows', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);

    const board = carry.carryForwardBoard(asProviderAdmin(), second.bid.id);
    assert.equal(board.stage, 'ITT');
    assert.equal(board.follows?.reference, first.bid.reference);

    const row = board.questions.find((entry) => entry.questionId === second.questionId)!;
    assert.ok(row.candidates >= 1);
    // Exactly one from the lineage: the PQQ this bid follows has one approved
    // answer to this question, and that is the number that is a fact about
    // this pair rather than about how many bids the customer has.
    assert.equal(row.fromLineage, 1);
    assert.equal(row.answered, false);
    assert.ok(row.best !== null && row.best >= carry.MINIMUM_CARRY_MATCH);
    assert.match(board.summary, new RegExp(first.bid.reference));
  });

  it('stops pointing at a question once it is answered here', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);
    bids.recordAnswer(asBidWriter(), second.bid.id, {
      questionId: second.questionId,
      body: ['Written for this buyer, from the earlier answer.'],
      citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
    });

    const board = carry.carryForwardBoard(asProviderAdmin(), second.bid.id);
    const row = board.questions.find((entry) => entry.questionId === second.questionId)!;
    assert.equal(row.answered, true);
    // The candidates are still there to read; what changes is that the board
    // no longer counts it as somewhere to start.
    assert.ok(row.candidates >= 1);
    assert.match(board.summary, /Nothing to carry forward/);
  });
});

describe('reuse goes through recordAnswer, and the lineage is verified', () => {
  it('records where the answer came from', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);

    const written = bids.recordAnswer(asBidWriter(), second.bid.id, {
      questionId: second.questionId,
      body: ['Every operative holds a current ECS card, and for this scheme we add a nominated safety supervisor.'],
      citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
      carriedFrom: { bidId: first.bid.id, answerId: first.answerId },
    });

    assert.equal(written.answer.carriedFrom?.answerId, first.answerId);
    assert.equal(written.answer.carriedFrom?.bidReference, first.bid.reference);
    assert.equal(written.answer.carriedFrom?.questionNumber, 'Q7');
    // Through the ordinary door, so it starts in review exactly as a fresh
    // answer does. A carried-forward answer nobody re-read is the boilerplate
    // this is meant to prevent.
    assert.equal(written.answer.status, 'IN_REVIEW');
    assert.equal(written.answer.version, 1);
  });

  it('refuses a lineage pointing at another customer, at the same bid, or at a draft', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);

    const theirs = bids.createBid(asProviderAdmin(), {
      engagementId: rivalEngagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'SQ_PA23',
      stage: 'PQQ',
      deadline: '2027-03-01',
    });
    throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), second.bid.id, {
          questionId: second.questionId,
          body: ['Carried from somebody else.'],
          citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
          carriedFrom: { bidId: theirs.id, answerId: first.answerId },
        }),
      'BID_ON_CARRY_NOT_THIS_CUSTOMER',
    );

    throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), second.bid.id, {
          questionId: second.questionId,
          body: ['Carried from itself.'],
          citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
          carriedFrom: { bidId: second.bid.id, answerId: first.answerId },
        }),
      'BID_ON_CARRY_SAME_BID',
    );

    // A draft on another of this customer's bids: moving one between packs is
    // not carrying an approved answer forward.
    const other = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: '2027-05-01',
    });
    bids.confirmQuestions(asProviderAdmin(), other.id, {
      questions: [
        { section: 'Health and safety', number: 'A1', text: PQQ_WORDING, answerType: 'TEXT', mandatory: true, passFail: false },
      ],
    });
    const draft = bids.recordAnswer(asBidWriter(), other.id, {
      questionId: bids.requireBid(asProviderAdmin(), other.id).questions[0]!.id,
      body: ['Never approved.'],
      citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
    });
    throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), second.bid.id, {
          questionId: second.questionId,
          body: ['Carried from a draft.'],
          citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
          carriedFrom: { bidId: other.id, answerId: draft.answer.id },
        }),
      'BID_ON_CARRY_NOT_APPROVED',
    );
  });

  it('refuses a question that is not on this bid', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);
    throwsCode(
      () => carry.priorAnswers(asProviderAdmin(), second.bid.id, first.questionId),
      'BID_ON_QUESTION_NOT_FOUND',
    );
  });
});

describe('it offers and it does not paste', () => {
  it('has no function that writes an answer into a bid', () => {
    /*
     * The rule this whole feature turns on, and it is an absence — so it is
     * checked against the source, the only way an absence can be. The same
     * check `answers.test.ts` makes about the standard section's library, for
     * the same reason: an answer pasted unchanged into the next submission is
     * boilerplate, and boilerplate is what a buyer marks down.
     */
    const raw = readFileSync(join(REPO_ROOT, 'backend', 'src', 'domain', 'bidon', 'carryforward.ts'), 'utf8');
    // Comments stripped first. The file's own docstring names `applyAnswer`
    // and `pasteAnswer` precisely in order to say they are absent, and a
    // scanner that read prose would be checking the wrong thing — it would
    // fail on a file for explaining itself and pass on one that said nothing.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /\bapply\w*Answer/i,
      /\bpasteAnswer/i,
      /\binsertAnswer/i,
      /\bfillQuestion/i,
      /\bcopyAnswer/i,
    ]) {
      assert.ok(!forbidden.test(source), `carryforward.ts contains ${forbidden}, which would paste rather than offer`);
    }
    // And it writes nothing at all: no event, no ledger call.
    assert.ok(!/\bwrite\(/.test(source), 'carryforward.ts writes to the ledger; it is a read');
    assert.ok(!/eventType:/.test(source), 'carryforward.ts emits an event; it is a read');
  });

  it('says on every offer that these are candidates rather than answers', () => {
    const first = wonPqq();
    const second = followingItt(first.bid.id);
    const offer = carry.priorAnswers(asProviderAdmin(), second.bid.id, second.questionId);
    assert.ok(
      offer.limits.some((line) => /candidates, not answers/.test(line)),
      'the offer does not say what it is',
    );
    assert.equal(offer.method, 'TERM_OVERLAP');
  });
});
