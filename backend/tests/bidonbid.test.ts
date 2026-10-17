import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
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
