import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as engine from '../src/domain/bidon/engine.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { CriterionScores } from '../src/domain/bidon/rubric.ts';

/**
 * The bid vertical: evidence, questions, answers, gaps, readiness, export.
 *
 * The acceptance criteria this suite exists for, in the specification's own
 * words:
 *
 *   - *"a guest or unassigned staff member gets 404 on another customer's data,
 *     and retrieval never returns another customer's evidence"*
 *   - *"95% or more of drafted answers carry at least one valid citation; none
 *     state an uncited fact"* — the mechanism rather than the percentage: a
 *     citation is refused unless it points at this customer's own evidence and
 *     at a passage that exists
 *   - *"export is blocked until every mandatory answer is approved"*
 *   - *"a bid started directly in Bid-On, with no standard tender, runs end to
 *     end and never appears in the standard Tenders section"*
 *
 * Everything here runs with no AI provider configured, which is the point of
 * keeping the records, the lifecycle and the gates separate from the agents:
 * a human-written pack behaves identically to an agent-written one, and the
 * hard rules can be tested without a provider.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/**
 * The reviewer, and a different person from the writer.
 *
 * The director, because `BID_SERVICES` `A` is held by OWNER and EXECUTIVE and
 * the seeded tenancy has no executive. That is the real shape of a small
 * provider anyway: the bid writer writes and the director signs. What matters
 * for the self-approval refusal is only that it is not whoever wrote the
 * answer.
 */
const asReviewer = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const DEADLINE = '2027-06-01';
const HASH = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;

/** Reasons for every criterion, because a score with none is refused. */
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

/** Write an answer and score it — the two acts the specification keeps apart. */
const writeAndScore = (
  ctx: EngineContext,
  bidId: string,
  input: Parameters<typeof bids.recordAnswer>[2],
  scores: CriterionScores = FULL,
) => {
  const written = bids.recordAnswer(ctx, bidId, input);
  // Scored by somebody, not by the drafter: `recordAnswer` has no score field
  // at all, which is what makes the separation structural.
  return bids.scoreAnswer(asProviderAdmin(), bidId, written.answer.id, { scores, reasons: REASONS });
};

let thornhill: customers.CustomerAccount;
let calder: customers.CustomerAccount;
let engagement: engagements.Engagement;
let policy: evidence.BidOnEvidence;

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

  thornhill = customers.openCustomer(asProviderAdmin(), { legalName: 'Thornhill Electrical Services Ltd' });
  calder = customers.openCustomer(asProviderAdmin(), { legalName: 'Calder Civils Ltd' });
  customers.assignStaff(asProviderAdmin(), thornhill.id, {
    add: [asBidWriter().auth.actorId, asReviewer().auth.actorId],
  });

  engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: thornhill.id,
    name: 'UVDB prequalification',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);

  policy = evidence.fileEvidence(asProviderAdmin(), {
    customerAccountId: thornhill.id,
    type: 'POLICY',
    title: 'Health and safety policy 2026',
    hash: HASH('a'),
  });
  policy = evidence.recordExtraction(asProviderAdmin(), policy.id, {
    extractedText: ['Our health and safety policy is reviewed annually by the board.'],
    chunks: [
      {
        pageRef: 'page 4',
        text:
          'Every operative holds a current ECS card and every site has a nominated first aider. Accident ' +
          'statistics are reported to the board quarterly and to our clients on request.',
      },
      {
        pageRef: 'page 7',
        text:
          'Apprenticeships: we take two apprentices through a level 3 NVQ on every scheme over one million pounds, ' +
          'with the college nearest the site, and report starts and completions quarterly.',
      },
    ],
  });
});

describe('the bid vertical is wired into the platform', () => {
  it('routes every act, classifies both entities, and splits authorship', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/bid-on/customers/:customerId/evidence'],
      ['POST', '/v1/bid-on/customers/:customerId/evidence'],
      ['POST', '/v1/bid-on/evidence/:evidenceId/extraction'],
      ['POST', '/v1/bid-on/evidence/:evidenceId/withdraw'],
      ['GET', '/v1/bid-on/customers/:customerId/retrieval'],
      ['GET', '/v1/bid-on/bids'],
      ['POST', '/v1/bid-on/bids'],
      ['GET', '/v1/bid-on/bids/:bidId'],
      ['POST', '/v1/bid-on/bids/:bidId/questions'],
      ['POST', '/v1/bid-on/bids/:bidId/answers'],
      ['POST', '/v1/bid-on/bids/:bidId/answers/:answerId/approve'],
      ['POST', '/v1/bid-on/bids/:bidId/answers/:answerId/reject'],
      ['POST', '/v1/bid-on/bids/:bidId/gaps'],
      ['POST', '/v1/bid-on/bids/:bidId/gaps/:gapId/resolve'],
      ['POST', '/v1/bid-on/bids/:bidId/export'],
      ['POST', '/v1/bid-on/bids/:bidId/outcome'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    assert.equal(classifyEntity('BidOnEvidence')?.sensitivity, 'COMMERCIAL_L3');
    assert.equal(classifyEntity('BidOnBid')?.area, 'BID_SERVICES');

    // An agent may read a file, draft prose and score it. It may not file
    // evidence against a customer, confirm the question list, approve or reject
    // an answer, export a pack or record an outcome.
    for (const type of ['BID_ON_EVIDENCE_EXTRACTED', 'BID_ON_ANSWER_DRAFTED', 'BID_ON_ANSWER_SCORED', 'BID_ON_GAP_RAISED']) {
      assert.equal(lookupEventType(type)?.aiAllowed, true, `${type} is closed to an agent that should author it`);
    }
    for (const type of [
      'BID_ON_EVIDENCE_FILED',
      'BID_ON_QUESTIONS_CONFIRMED',
      'BID_ON_ANSWER_APPROVED',
      'BID_ON_ANSWER_REJECTED',
      'BID_ON_GAP_RESOLVED',
      'BID_ON_BID_EXPORTED',
      'BID_ON_BID_OUTCOME_RECORDED',
    ]) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
  });
});

describe('the evidence library belongs to one customer', () => {
  it('refuses a certificate with no expiry, because that disables a hard rule', () => {
    const error = throwsCode(
      () =>
        evidence.fileEvidence(asProviderAdmin(), {
          customerAccountId: thornhill.id,
          type: 'CERTIFICATE',
          title: 'ISO 9001 certificate',
          hash: HASH('b'),
        }),
      'BID_ON_EXPIRY_REQUIRED',
    );
    assert.match(String(error.message), /safety check switched off/);

    const filed = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      type: 'CERTIFICATE',
      title: 'ISO 9001 certificate',
      hash: HASH('b'),
      expiresOn: '2027-03-01',
    });
    assert.equal(filed.expiresOn, '2027-03-01');
  });

  it('refuses a CV with no data-subject consent', () => {
    const error = throwsCode(
      () =>
        evidence.fileEvidence(asProviderAdmin(), {
          customerAccountId: thornhill.id,
          type: 'CV',
          title: 'CV — site supervisor',
          hash: HASH('c'),
        }),
      'BID_ON_CONSENT_REQUIRED',
    );
    assert.match(String(error.message), /named person’s data going to a buyer/);

    const filed = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      type: 'CV',
      title: 'CV — site supervisor',
      hash: HASH('c'),
      consent: { subject: 'A. Supervisor', basis: 'Signed consent form held on the personnel file' },
    });
    assert.equal(filed.consent?.subject, 'A. Supervisor');
    assert.equal(filed.consent?.capturedBy, asProviderAdmin().auth.actorId);
  });

  it('refuses the same file twice for one customer', () => {
    throwsCode(
      () =>
        evidence.fileEvidence(asProviderAdmin(), {
          customerAccountId: thornhill.id,
          type: 'POLICY',
          title: 'The same policy again',
          hash: HASH('a'),
        }),
      'BID_ON_EVIDENCE_EXISTS',
    );
  });

  it('keeps nothing usable rather than indexing a fragment', () => {
    const filed = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      type: 'STATS',
      title: 'Accident frequency rate 2026',
      hash: HASH('d'),
    });
    const error = throwsCode(
      () => evidence.recordExtraction(asProviderAdmin(), filed.id, { extractedText: ['AFR 0.12'], chunks: [{ text: 'AFR 0.12' }] }),
      'BID_ON_NOTHING_EXTRACTED',
    );
    assert.match(String(error.message), /still citable as an attachment/);
  });

  it('shows one customer’s library and refuses another’s by id', () => {
    const mine = evidence.evidenceLibrary(asProviderAdmin(), thornhill.id);
    assert.ok(mine.evidence.length >= 3);
    assert.ok(mine.evidence.every((item) => item.customerAccountId === thornhill.id));

    // The bid writer is assigned to Thornhill and not to Calder.
    assert.ok(evidence.evidenceLibrary(asBidWriter(), thornhill.id).evidence.length >= 3);
    throwsCode(() => evidence.evidenceLibrary(asBidWriter(), calder.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');

    // And an evidence id from another customer is refused rather than returned.
    const theirs = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: calder.id,
      type: 'POLICY',
      title: 'Calder’s own policy',
      hash: HASH('e'),
    });
    throwsCode(() => evidence.requireEvidence(asBidWriter(), theirs.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');
  });

  it('says what has lapsed and what nothing has been read out of', () => {
    const library = evidence.evidenceLibrary(asProviderAdmin(), thornhill.id, { asAt: '2027-06-01' });
    assert.ok(
      library.limits.some((line) => /have lapsed/.test(line)),
      'a certificate that expired before the day asked about is not reported',
    );
    assert.ok(library.limits.some((line) => /nothing read out of them/.test(line)));
  });
});

describe('retrieval never crosses a customer boundary', () => {
  before(() => {
    const theirs = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: calder.id,
      type: 'POLICY',
      title: 'Calder apprenticeship policy',
      hash: HASH('f'),
    });
    evidence.recordExtraction(asProviderAdmin(), theirs.id, {
      extractedText: ['Calder takes apprentices on every scheme.'],
      chunks: [
        {
          text:
            'Apprenticeships: Calder Civils takes four apprentices through a level 3 NVQ every year and reports ' +
            'starts and completions to its clients each quarter without being asked.',
        },
      ],
    });
  });

  it('returns only the asked-for customer’s passages, however well another’s match', () => {
    // Both customers have an apprenticeship passage, and the other one matches
    // the question at least as well. This is the acceptance criterion.
    const result = evidence.retrieveFor(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      question: 'Describe your apprenticeship commitments and how completions are reported',
      asAt: DEADLINE,
    });
    assert.ok(result.chunks.length > 0, 'nothing was retrieved for a question the library can answer');
    assert.ok(
      result.chunks.every((chunk) => chunk.reference.startsWith('EVD-')),
      'a retrieved passage carries no reference',
    );
    for (const chunk of result.chunks) {
      assert.ok(
        !chunk.text.includes('Calder Civils'),
        'another customer’s material was returned for this customer’s question',
      );
    }
    assert.match(result.note, /every one from this customer/);
  });

  it('returns nothing rather than the least irrelevant passage', () => {
    const result = evidence.retrieveFor(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      question: 'Describe your approach to marine piling in tidal estuaries',
      asAt: DEADLINE,
    });
    assert.deepEqual(result.chunks, []);
    assert.ok(result.considered > 0, 'nothing was considered, so the floor was not what refused');
    assert.match(result.note, /makes it a gap the customer can fix/);
  });

  it('does not offer evidence that has lapsed by the deadline', () => {
    const lapsing = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      type: 'INSURANCE',
      title: 'Employers liability schedule',
      hash: HASH('9'),
      expiresOn: '2027-01-01',
    });
    evidence.recordExtraction(asProviderAdmin(), lapsing.id, {
      extractedText: ['Cover of ten million pounds each and every claim.'],
      chunks: [
        {
          text:
            'Employers liability insurance: cover of ten million pounds each and every claim, underwritten and ' +
            'renewed annually on the first of January.',
        },
      ],
    });

    const atDeadline = evidence.retrieveFor(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      question: 'State your employers liability insurance cover',
      asAt: DEADLINE,
    });
    assert.ok(
      !atDeadline.chunks.some((chunk) => chunk.reference === lapsing.reference),
      'evidence that lapses before the deadline was offered to a drafter',
    );

    // Current earlier, so it is the date that refused and not the match.
    const earlier = evidence.retrieveFor(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      question: 'State your employers liability insurance cover',
      asAt: '2026-12-01',
    });
    assert.ok(earlier.chunks.some((chunk) => chunk.reference === lapsing.reference));
  });
});

describe('a bid runs end to end with no tender in the standard section', () => {
  let bid: bids.Bid;

  it('is refused against an engagement that is not open', () => {
    const draft = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      name: 'Never activated',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 1,
      currency: 'GBP',
    });
    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: draft.id,
          buyerName: 'National Grid Electricity Distribution',
          scheme: 'UVDB',
          deadline: DEADLINE,
        }),
      'BID_ON_ENGAGEMENT_NOT_OPEN',
    );
  });

  it('opens standalone, with no source tender', () => {
    bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Distribution',
      scheme: 'UVDB',
      deadline: DEADLINE,
      buyerReference: 'NGED-UVDB-2027-04',
    });
    assert.match(bid.reference, /^BON-\d{4}$/);
    assert.equal(bid.status, 'CREATED');
    assert.equal(bid.sourceTenderId, undefined, 'a standalone bid carries a source tender');
    assert.equal(bid.customerAccountId, thornhill.id);
    // The rubric is copied, not referenced: a reversion next month must not
    // restate what a sent submission was scored against.
    assert.equal(bid.weights.COMPLIANCE, 0.3);

    const register = bids.bidRegister(asProviderAdmin());
    assert.ok(register.bids.some((entry) => entry.id === bid.id && entry.standalone));
  });

  it('refuses a duplicate question number, and confirms the list once', () => {
    const duplicate = throwsCode(
      () =>
        bids.confirmQuestions(asProviderAdmin(), bid.id, {
          questions: [
            { section: 'HSEQ', number: '4.1', text: 'Describe your safety management system', answerType: 'TEXT', mandatory: true },
            { section: 'HSEQ', number: '4.1', text: 'And again', answerType: 'TEXT', mandatory: true },
          ],
        }),
      'BID_ON_NUMBER_DUPLICATED',
    );
    assert.match(String(duplicate.message), /what the export has to match/);

    bid = bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        {
          section: 'HSEQ',
          number: '4.1',
          text: 'Describe your health and safety management arrangements and how accident statistics are reported',
          answerType: 'TEXT',
          wordLimit: 500,
          weighting: 30,
          mandatory: true,
        },
        {
          section: 'Social value',
          number: '6.2',
          text: 'Describe your apprenticeship commitments and how completions are reported',
          answerType: 'TEXT',
          wordLimit: 300,
          weighting: 20,
          mandatory: true,
        },
        {
          section: 'Insurance',
          number: '5.1',
          text: 'Do you hold employers liability insurance of at least five million pounds?',
          answerType: 'YES_NO',
          mandatory: true,
          passFail: true,
        },
        {
          section: 'Quality',
          number: '7.4',
          text: 'Describe your approach to marine piling in tidal estuaries',
          answerType: 'TEXT',
          weighting: 10,
          mandatory: false,
        },
      ],
    });
    assert.equal(bid.questions.length, 4);
    assert.equal(bid.status, 'DRAFTING');
    assert.equal(bid.questionsConfirmedBy, asProviderAdmin().auth.actorId);

    // Once. Reattaching approved answers to a changed list is worse than the
    // parsing error it would fix.
    const again = throwsCode(
      () =>
        bids.confirmQuestions(asProviderAdmin(), bid.id, {
          questions: [{ section: 'X', number: '1', text: 'Anything', answerType: 'TEXT', mandatory: true }],
        }),
      'BID_ON_QUESTIONS_CONFIRMED',
    );
    assert.match(String(again.message), /resync the source instead/);
  });

  it('refuses a citation that points at another customer’s evidence', () => {
    // The one field an agent supplies that could name another customer's
    // material. Refused rather than filtered out: a silently dropped citation
    // leaves an uncited claim reading as a cited one.
    const theirs = evidence.evidenceLibrary(asProviderAdmin(), calder.id).evidence[0]!;
    const theirChunk = evidence.requireEvidence(asProviderAdmin(), theirs.id).chunks[0];

    const error = throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), bid.id, {
          questionId: bid.questions[0]!.id,
          body: ['We do what Calder does.'],
          citations: [{ evidenceId: theirs.id, chunkId: theirChunk?.id ?? 'x' }],
        }),
      'BID_ON_CITATION_FOREIGN',
    );
    assert.match(String(error.message), /never appear in another customer’s answer/);
    assert.match(String(error.message), /silently dropped citation/);
  });

  it('refuses a citation to a passage that does not exist', () => {
    throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), bid.id, {
          questionId: bid.questions[0]!.id,
          body: ['Our arrangements are set out in our policy.'],
          citations: [{ evidenceId: policy.id, chunkId: 'not-a-passage' }],
        }),
      'BID_ON_CITATION_UNKNOWN',
    );
  });

  it('writes an answer with citations, as a new version each time', () => {
    const chunks = evidence.requireEvidence(asProviderAdmin(), policy.id).chunks;

    const first = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[0]!.id,
      body: ['Every operative holds a current ECS card and accident statistics go to the board quarterly.'],
      citations: [{ evidenceId: policy.id, chunkId: chunks[0]!.id }],
    });
    assert.equal(first.answer.version, 1);
    assert.equal(first.answer.status, 'IN_REVIEW');
    assert.equal(first.answer.citations[0]!.reference, policy.reference);
    assert.equal(first.answer.citations[0]!.pageRef, 'page 4');

    const second = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[0]!.id,
      body: ['Rewritten, with the reporting line to the board named explicitly.'],
      citations: [{ evidenceId: policy.id, chunkId: chunks[0]!.id }],
    });
    assert.equal(second.answer.version, 2);
    // Nothing overwritten: the version that went to a buyer is a promise.
    assert.equal(second.bid.answers.filter((entry) => entry.questionId === bid.questions[0]!.id).length, 2);
    bid = second.bid;
  });

  it('insists on the yes/no field, because the hard rule reads it', () => {
    const error = throwsCode(
      () =>
        bids.recordAnswer(asBidWriter(), bid.id, {
          questionId: bid.questions[2]!.id,
          body: ['Yes, we hold ten million pounds of cover.'],
        }),
      'BID_ON_YES_NO_REQUIRED',
    );
    assert.match(String(error.message), /Prose alone leaves it unanswered/);
  });

  it('refuses an approval by the person who wrote it, and accepts a second reader', () => {
    /*
     * The refusal is only reachable for somebody who holds both verbs, and
     * that is the point of the role split rather than a gap in it: the bid
     * writer holds C, U, X and I on `BID_SERVICES` and no A at all, so an
     * approval from them is refused one level earlier by the capability check.
     * The person who can hit the self-approval rule is the director, who can
     * both write and approve — and that is exactly who it exists to stop.
     */
    const chunks = evidence.requireEvidence(asProviderAdmin(), policy.id).chunks;
    const own = writeAndScore(asReviewer(), bid.id, {
      questionId: bid.questions[0]!.id,
      body: ['The director’s own rewrite of the safety arrangements answer.'],
      citations: [{ evidenceId: policy.id, chunkId: chunks[0]!.id }],
    });

    const self = throwsCode(
      () => bids.approveAnswer(asReviewer(), bid.id, own.answer.id, { note: 'Approving my own work here' }),
      'BID_ON_SELF_APPROVAL',
    );
    assert.match(String(self.message), /one person at both ends/);

    // The bid writer, whose work the director may sign.
    const written = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[0]!.id,
      body: ['Every operative holds a current ECS card and accident statistics go to the board quarterly.'],
      citations: [{ evidenceId: policy.id, chunkId: chunks[0]!.id }],
    });
    const approved = bids.approveAnswer(asReviewer(), bid.id, written.answer.id, {
      note: 'Checked against the policy at page 4 and the board reporting line',
    });
    assert.equal(approved.answer.status, 'APPROVED');
    assert.equal(approved.answer.reviewedBy, asReviewer().auth.actorId);
    assert.notEqual(approved.answer.writtenBy, approved.answer.reviewedBy);
    bid = approved.bid;

    // And the capability check is what refuses the writer, one level earlier.
    throwsCode(
      () => bids.approveAnswer(asBidWriter(), bid.id, written.answer.id, { note: 'Signing it off myself instead' }),
      'ACCESS_DENIED',
    );
  });

  it('refuses approval of a superseded version', () => {
    const first = bid.answers.find((entry) => entry.version === 1)!;
    const error = throwsCode(
      () => bids.approveAnswer(asReviewer(), bid.id, first.id, { note: 'Approving the old version by mistake' }),
      'BID_ON_ANSWER_SUPERSEDED',
    );
    assert.match(String(error.message), /text the pack is not going to send/);
  });

  it('rejects with instructions, and the instructions are mandatory', () => {
    const written = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[1]!.id,
      body: ['We are committed to apprenticeships.'],
    });

    throwsCode(
      () => bids.rejectAnswer(asReviewer(), bid.id, written.answer.id, { instructions: 'no' }),
      'BID_ON_INSTRUCTIONS_REQUIRED',
    );

    const rejected = bids.rejectAnswer(asReviewer(), bid.id, written.answer.id, {
      instructions: 'Name the number of starts and completions, and the college. Cite page 7 of the policy.',
    });
    assert.equal(rejected.answer.status, 'REJECTED');
    assert.match(String(rejected.answer.reviewNote), /starts and completions/);
    bid = rejected.bid;
  });

  it('raises a gap that pauses its own question and nothing else', () => {
    const raised = bids.raiseGap(asBidWriter(), bid.id, {
      questionId: bid.questions[3]!.id,
      promptToClient:
        'Have you done any marine piling in a tidal estuary? If so we need the scheme, the client and the dates.',
    });
    assert.equal(raised.gap.resolvedAt, undefined);

    // One request per question. Two is two emails the customer reconciles.
    throwsCode(
      () =>
        bids.raiseGap(asBidWriter(), bid.id, {
          questionId: bid.questions[3]!.id,
          promptToClient: 'Asking for the same thing a second time in a different email.',
        }),
      'BID_ON_GAP_OPEN',
    );

    // And the rest of the pack is still workable.
    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    assert.equal(position.openGaps.length, 1);
    assert.ok(position.questions.some((entry) => entry.answer !== null));
    bid = raised.bid;
  });

  it('refuses the export while a mandatory answer is red or unapproved, naming every one', () => {
    const error = throwsCode(() => bids.exportBid(asProviderAdmin(), bid.id), 'BID_ON_NOT_EXPORTABLE');
    const message = String(error.message);
    // Every blocking answer, not the first.
    assert.match(message, /6\.2/);
    assert.match(message, /5\.1/);
    assert.match(message, /not marked down, it is rejected/);
  });

  it('scores the pass/fail question red on a "no", whatever the prose says', () => {
    const no = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[2]!.id,
      body: ['We hold cover of two million pounds and are increasing it at renewal.'],
      yesNo: false,
    });
    bid = no.bid;

    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    const passFail = position.questions.find((entry) => entry.question.number === '5.1')!;
    assert.equal(passFail.verdict.rag, 'RED');
    assert.equal(passFail.verdict.weightedBand, 'GREEN', 'the prose scored badly, so this is not the hard rule');
    assert.deepEqual(
      passFail.verdict.hardRules.map((hit) => hit.rule),
      ['PASS_FAIL_FAILED'],
    );
  });

  it('exports once every mandatory answer is approved and out of red, then records the outcome', () => {
    // Fix the pass/fail answer and write the social value one properly.
    const chunks = evidence.requireEvidence(asProviderAdmin(), policy.id).chunks;

    const yes = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[2]!.id,
      body: ['Yes. Cover of ten million pounds each and every claim, renewed annually.'],
      yesNo: true,
    });
    bids.approveAnswer(asReviewer(), bid.id, yes.answer.id, {
      note: 'Confirmed against the insurance schedule on file',
    });

    const social = writeAndScore(asBidWriter(), bid.id, {
      questionId: bid.questions[1]!.id,
      body: [
        'Two apprentices through a level 3 NVQ on every scheme over one million pounds, with the college nearest ' +
          'the site, and starts and completions reported quarterly.',
      ],
      citations: [{ evidenceId: policy.id, chunkId: chunks[1]!.id }],
    });
    bids.approveAnswer(asReviewer(), bid.id, social.answer.id, {
      note: 'Figures and the college match page 7 of the policy',
    });

    const ready = bids.bidPosition(asProviderAdmin(), bid.id);
    assert.equal(ready.readiness.exportable, true, `still blocked: ${JSON.stringify(ready.readiness.blocking)}`);
    // The optional question is red and unapproved and does not block: those are
    // conceded marks, not a rejection.
    assert.ok(ready.questions.some((entry) => !entry.question.mandatory && entry.verdict.rag === 'RED'));

    const exported = bids.exportBid(asProviderAdmin(), bid.id);
    assert.equal(exported.bid.status, 'EXPORTED');
    assert.ok(exported.bid.exportedAt);

    // An outcome follows a submission, and a result follows the outcome.
    throwsCode(
      () => bids.recordBidOutcome(asProviderAdmin(), bid.id, { outcome: 'WON' }),
      'BID_ON_NOT_SUBMITTED',
    );
    const submitted = bids.recordBidOutcome(asProviderAdmin(), bid.id, { outcome: 'SUBMITTED' });
    assert.equal(submitted.status, 'SUBMITTED');

    const won = bids.recordBidOutcome(asProviderAdmin(), bid.id, {
      outcome: 'WON',
      feedback: 'Scored 92 on quality. Social value was the strongest answer.',
    });
    assert.equal(won.status, 'WON');
    assert.match(String(won.outcome?.feedback), /Scored 92/);

    // And a sent pack is frozen.
    throwsCode(
      () => bids.recordAnswer(asBidWriter(), bid.id, { questionId: bid.questions[0]!.id, body: ['Changing it after it went'] }),
      'BID_ON_BID_SENT',
    );
  });
});

describe('a bid is invisible to anybody not assigned to its customer', () => {
  it('refuses it by id and leaves it out of the register, saying how many', () => {
    const theirEngagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: calder.id,
      name: 'Calder’s own prequalification',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 150_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), theirEngagement.id);
    const theirs = bids.createBid(asProviderAdmin(), {
      engagementId: theirEngagement.id,
      buyerName: 'Yorkshire Water',
      scheme: 'PAS91',
      deadline: DEADLINE,
    });

    // The bid writer is assigned to Thornhill only.
    throwsCode(() => bids.requireBid(asBidWriter(), theirs.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');
    throwsCode(() => bids.bidPosition(asBidWriter(), theirs.id), 'BID_ON_CUSTOMER_NOT_ASSIGNED');

    const register = bids.bidRegister(asBidWriter());
    assert.ok(!register.bids.some((entry) => entry.id === theirs.id));
    assert.ok(
      register.limits.some((line) => /further bid\(s\) exist/.test(line)),
      'the register looks complete while withholding bids',
    );
  });
});

describe('the Bid Engine refuses the local stand-in before it charges', () => {
  /**
   * Every one of the four AI commands, and the refusal that matters most.
   *
   * This deployment runs the local stand-in in tests, which answers every
   * request with a deterministic sentence derived from a hash of its inputs.
   * Prose from it — sent to a buyer, under a customer's name, as their answer
   * to a mandatory question — is a false statement. `requireModel` refuses
   * before the charge is settled, so nobody pays for a refusal.
   */
  let engineBid: bids.Bid;

  before(() => {
    engineBid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Northern Powergrid',
      scheme: 'SQ_PA23',
      deadline: DEADLINE,
    });
  });

  it('refuses to read a questionnaire on it, and changes nothing', async () => {
    await assert.rejects(
      () => engine.parseQuestionnaire(asProviderAdmin(), platform.evidence, engineBid.id, { text: '4.1 Describe your safety system' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'NO_REASONING_PROVIDER');
        return true;
      },
    );
    const after = bids.requireBid(asProviderAdmin(), engineBid.id);
    assert.equal(after.proposedQuestions, undefined, 'a refused parse left a proposal behind');
    assert.equal(after.status, 'CREATED');
  });

  it('refuses to parse with nothing to parse, before it reaches a provider', async () => {
    await assert.rejects(
      () => engine.parseQuestionnaire(asProviderAdmin(), platform.evidence, engineBid.id, {}),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_ON_NOTHING_TO_PARSE');
        return true;
      },
    );
  });

  it('raises a gap instead of drafting when the customer has nothing to cite, and spends nothing', async () => {
    // The specification's rule — "unknowns become gaps" — and the honest
    // option: a model asked to answer a question its evidence cannot support
    // writes a plausible paragraph, which is the uncited claim that gets a
    // submission thrown out. No provider is reached at all, so it costs zero.
    const confirmed = bids.confirmQuestions(asProviderAdmin(), engineBid.id, {
      questions: [
        {
          section: 'Technical',
          number: '9.9',
          text: 'Describe your experience of subsea cable jointing in tidal waters',
          answerType: 'TEXT',
          mandatory: true,
        },
      ],
    });

    const result = await engine.draftAnswer(asProviderAdmin(), confirmed.id, {
      questionId: confirmed.questions[0]!.id,
    });
    assert.equal(result.outcome, 'GAP_RAISED');
    assert.equal(result.acuConsumed, 0, 'a gap raised without reaching a provider was charged for');
    assert.ok(result.gapId);

    const gap = result.bid.gaps.find((entry) => entry.id === result.gapId)!;
    assert.match(gap.promptToClient, /subsea cable jointing/);
    // Written for the customer: it says what to send, not that a retrieval
    // scored below a floor.
    assert.match(gap.promptToClient, /Please send/);
  });

  it('refuses to draft over an open gap rather than writing around what is missing', async () => {
    const confirmed = bids.requireBid(asProviderAdmin(), engineBid.id);
    await assert.rejects(
      () => engine.draftAnswer(asProviderAdmin(), confirmed.id, { questionId: confirmed.questions[0]!.id }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_ON_GAP_OPEN');
        return true;
      },
    );
  });

  it('refuses to compose a gap request when there is nothing to ask for', async () => {
    const other = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Cadent Gas',
      scheme: 'UVDB',
      deadline: DEADLINE,
    });
    await assert.rejects(
      () => engine.composeGapRequest(asProviderAdmin(), other.id),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_ON_NO_GAPS');
        return true;
      },
    );
  });

  it('refuses every agent run under a paused engagement', async () => {
    // The specification's prohibition: a paused engagement cannot consume ACU.
    // Enforced in one place so it cannot be missed on one route of four.
    const paused = engagements.pauseEngagement(asProviderAdmin(), engagement.id, {
      reason: 'Customer paused the work over the shutdown',
    });
    assert.equal(paused.status, 'PAUSED');

    const confirmed = bids.requireBid(asProviderAdmin(), engineBid.id);
    for (const [name, call] of [
      ['parse', () => engine.parseQuestionnaire(asProviderAdmin(), platform.evidence, confirmed.id, { text: 'anything' })],
      ['draft', () => engine.draftAnswer(asProviderAdmin(), confirmed.id, { questionId: confirmed.questions[0]!.id })],
      ['gap request', () => engine.composeGapRequest(asProviderAdmin(), confirmed.id)],
    ] as const) {
      await assert.rejects(
        call,
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'BID_ON_ENGAGEMENT_NOT_OPEN', `${name} ran under a paused engagement`);
          return true;
        },
      );
    }

    engagements.resumeEngagement(asProviderAdmin(), engagement.id);
  });

  it('quotes what finishing the pack would cost, sized from what is left', () => {
    const estimate = bids.acuEstimate(asProviderAdmin(), engineBid.id);
    assert.equal(estimate.questionsOutstanding, 1);
    assert.ok(estimate.runs >= 2, 'a draft and a score are two runs');
    assert.ok(estimate.chargeMinor > 0);
    assert.ok(estimate.chargeMinor >= estimate.rawCostMinor, 'the charge is below the provider cost');
    // It says it is an estimate rather than implying a price.
    assert.ok(estimate.limits.some((line) => /An estimate/.test(line)));
  });
});

/**
 * One part of a ZIP, inflated.
 *
 * Needed because the writer deflates: the sheet names and the cell values live
 * inside `xl/workbook.xml` and `xl/worksheets/sheetN.xml`, and a test that
 * searched the archive for them in the clear would pass only on a writer that
 * stored its parts uncompressed — which is the naive implementation this one
 * deliberately is not.
 *
 * Reads the local header rather than the central directory, which is enough
 * here and is the half a reader has to get right anyway: name length at offset
 * 26, extra length at 28, and the payload straight after both.
 */
function partOf(archive: Buffer, path: string): string {
  const needle = Buffer.from(path, 'utf8');
  for (let at = 0; at < archive.length - 4; at += 1) {
    if (archive.readUInt32LE(at) !== 0x04_03_4b_50) continue;
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength);
    if (!name.equals(needle)) continue;

    const method = archive.readUInt16LE(at + 8);
    const compressed = archive.readUInt32LE(at + 18);
    const start = at + 30 + nameLength + extraLength;
    const payload = archive.subarray(start, start + compressed);
    // Method 0 is stored, 8 is deflate. The writer picks whichever is smaller
    // per part, so both have to be handled.
    return (method === 8 ? inflateRawSync(payload) : payload).toString('utf8');
  }
  throw new Error(`${path} is not in the archive`);
}

describe('the pack comes out in the questionnaire’s own structure', () => {
  /**
   * The acceptance criterion: *"the DOCX/XLSX keeps the source numbering and
   * section order."* Asserted against the bytes, because a renderer that
   * reordered would pass any check made against the model it was given.
   */
  let ready: bids.Bid;
  const branding = () => platform.exports.branding(seed.tenantId);

  before(() => {
    // A pack whose sections are deliberately out of alphabetical order, so a
    // renderer that sorted would be caught rather than accidentally right.
    const own = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: thornhill.id,
      name: 'Render test',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 150_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), own.id);
    ready = bids.createBid(asProviderAdmin(), {
      engagementId: own.id,
      buyerName: 'Scottish Power Energy Networks',
      scheme: 'UVDB',
      deadline: DEADLINE,
    });
    ready = bids.confirmQuestions(asProviderAdmin(), ready.id, {
      questions: [
        { section: 'Zebra section', number: '9.1', text: 'The last section, first in the document', answerType: 'TEXT', mandatory: true },
        { section: 'Alpha section', number: '1.1', text: 'The first section, second in the document', answerType: 'TEXT', mandatory: true },
        { section: 'Zebra section', number: '9.2', text: 'Back in the first section again', answerType: 'TEXT', mandatory: false },
      ],
    });

    for (const question of ready.questions.filter((entry) => entry.mandatory)) {
      const written = bids.recordAnswer(asBidWriter(), ready.id, {
        questionId: question.id,
        body: [`Our answer to ${question.number}.`],
      });
      bids.scoreAnswer(asProviderAdmin(), ready.id, written.answer.id, { scores: FULL, reasons: REASONS });
      bids.approveAnswer(asReviewer(), ready.id, written.answer.id, {
        note: `Checked the answer to ${question.number} against the record`,
      });
    }
    ready = bids.requireBid(asProviderAdmin(), ready.id);
  });

  it('keeps the sections in the order the document had them, not sorted', () => {
    const pack = bids.renderPack(asProviderAdmin(), ready.id, 'TEXT', branding());
    // Zebra before Alpha, because that is the order the source had.
    assert.deepEqual(pack.sections, ['Zebra section', 'Alpha section']);
    assert.equal(pack.questions, 3);
  });

  it('writes the copy-ready text with the buyer’s own numbering and no formatting', () => {
    const pack = bids.renderPack(asProviderAdmin(), ready.id, 'TEXT', branding());
    assert.equal(pack.contentType, 'text/plain; charset=utf-8');
    // The buyer's numbers, in source order.
    const order = ['9.1', '1.1', '9.2'].map((number) => pack.content.indexOf(`${number} `));
    assert.ok(order.every((index) => index >= 0), 'a question number is missing from the text form');
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, 'the text form reordered the questions');
    // Nothing that arrives as literal asterisks in a portal textarea.
    assert.ok(!/\*\*|^#/m.test(pack.content), 'the portal text carries markdown');
  });

  it('strips internal evidence ids, chunk ids and gap notes from the submission, keeping them on the review copy', () => {
    // An answer carrying the internal machinery the drafter embeds: an inline
    // "(EVD-…, chunkId …)" citation and a meta-note that points "below" to a
    // review section the buyer's copy does not have. A buyer must see neither.
    const question = ready.questions.find((entry) => entry.number === '9.1')!;
    const written = bids.recordAnswer(asBidWriter(), ready.id, {
      questionId: question.id,
      body: [
        'We confirm our approach (EVD-0099, chunkId 01ABCDEFGHJKMNPQRSTVWXYZ00).',
        'The membership certificate is not attached here and is listed as unsupported below.',
      ],
    });
    bids.scoreAnswer(asProviderAdmin(), ready.id, written.answer.id, { scores: FULL, reasons: REASONS });
    bids.approveAnswer(asReviewer(), ready.id, written.answer.id, { note: 'Checked the 9.1 answer against the record' });
    const bid = bids.requireBid(asProviderAdmin(), ready.id);

    // This bid is exportable, so this is the real submission — it must be clean.
    const submission = bids.renderPack(asProviderAdmin(), bid.id, 'TEXT', branding()).content;
    assert.ok(!submission.includes('EVD-0099'), 'the submission leaks an internal evidence id');
    assert.ok(!/chunk\s?id/i.test(submission), 'the submission leaks a chunk id');
    assert.ok(!/unsupported below|not attached here/i.test(submission), 'the submission leaks an internal gap note');
    assert.ok(!/\nEvidence:/.test(submission), 'the submission leaks the internal evidence-reference line');
    assert.ok(submission.includes('We confirm our approach'), 'the sanitiser destroyed the real prose');
  });

  it('writes a real spreadsheet with a sheet per section, in source order', () => {
    const pack = bids.renderPack(asProviderAdmin(), ready.id, 'XLSX', branding());
    assert.match(pack.filename, /\.xlsx$/);
    assert.equal(pack.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const bytes = Buffer.from(pack.content, 'base64');
    // A real ZIP, not a renamed CSV.
    assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');

    const names = bytes.toString('latin1');
    // The parts a spreadsheet needs, by name — a workbook missing any of these
    // opens as a repair prompt rather than a file. The filenames are in the
    // local headers uncompressed, so they can be read directly.
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      assert.ok(names.includes(part), `the workbook has no ${part}`);
    }

    // The sheet names are inside the deflated workbook part, so this inflates
    // it rather than scanning the archive for a string that is not there in
    // the clear. A test that searched the raw bytes would pass on a stored
    // (uncompressed) writer and fail on a correct one.
    const workbook = partOf(bytes, 'xl/workbook.xml');
    const zebra = workbook.indexOf('Zebra section');
    const alpha = workbook.indexOf('Alpha section');
    assert.ok(zebra >= 0 && alpha >= 0, `a section name is missing from the workbook: ${workbook}`);
    assert.ok(zebra < alpha, 'the workbook sorted the sheets');

    // A row per question, in the buyer's numbering, on the sheet for its own
    // section.
    const first = partOf(bytes, 'xl/worksheets/sheet1.xml');
    assert.ok(first.includes('9.1'), 'the first sheet does not carry its own section’s questions');
    assert.ok(first.includes('9.2'));
    assert.ok(!first.includes('1.1'), 'a question from another section is on this sheet');
  });

  it('writes a real Word file carrying the answers', () => {
    const pack = bids.renderPack(asProviderAdmin(), ready.id, 'DOCX', branding());
    assert.match(pack.filename, /\.docx$/);
    const bytes = Buffer.from(pack.content, 'base64');
    assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');
    const text = bytes.toString('latin1');
    assert.ok(text.includes('word/document.xml'), 'the file is not a Word document');
  });

  it('is byte-identical on a second render, so a pack can be proved', () => {
    // The ZIP writer uses a fixed timestamp for exactly this: two renders of
    // one pack are the same instrument, and a difference means the pack
    // changed rather than the clock did.
    const first = bids.renderPack(asProviderAdmin(), ready.id, 'XLSX', branding());
    const second = bids.renderPack(asProviderAdmin(), ready.id, 'XLSX', branding());
    assert.equal(first.content, second.content);
  });

  it('refuses to render a pack that cannot be exported, so the gate is not a formality', () => {
    // Without this, anybody blocked from exporting could render the same file
    // and send it.
    const blocked = bids.createBid(asProviderAdmin(), {
      engagementId: ready.engagementId,
      buyerName: 'Electricity North West',
      scheme: 'UVDB',
      deadline: DEADLINE,
    });
    bids.confirmQuestions(asProviderAdmin(), blocked.id, {
      questions: [
        { section: 'HSEQ', number: '1.1', text: 'A mandatory question nobody has answered', answerType: 'TEXT', mandatory: true },
      ],
    });

    const error = throwsCode(
      () => bids.renderPack(asProviderAdmin(), blocked.id, 'DOCX', branding()),
      'BID_ON_NOT_EXPORTABLE',
    );
    assert.match(String(error.message), /would make the gate a formality/);
  });
});
