import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * Two stages of one procurement, and the questions you get to ask at each.
 *
 * ## Why a stage is on the record rather than in a reference
 *
 * A PQQ and the ITT that follows it are **two submissions to one buyer about
 * one job**. They have separate question sets, separate return dates, separate
 * clarification windows and separate outcomes. Treating them as one bid loses
 * the PQQ's own result; treating them as unrelated loses the fact that the ITT
 * exists only because the PQQ was won, and that everything said at the PQQ
 * stage is on the record the ITT is read against.
 *
 * ## Why a clarification needed states
 *
 * The module raises most clarifications itself — a question with no stated
 * limit, a returnable with no stated format, an amendment that shifts a risk —
 * and a note nobody sent is worth nothing. What decides whether a bid team got
 * the benefit is whether the question reached the buyer **before their
 * clarification deadline**, which is a different date at each stage and is
 * always well before the return. That is the date nobody watches, and the one
 * these tests are mostly about.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

let customer: customers.CustomerAccount;
let rival: customers.CustomerAccount;
let engagement: engagements.Engagement;
let rivalEngagement: engagements.Engagement;

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
    type: 'STAGED',
    billingBasis: 'PER_STAGE',
    feeMinor: 300_000,
    currency: 'GBP',
    stages: [
      // A stage scope has a minimum length: "the PQQ" tells a customer nothing
      // about what they are paying for, and the module refuses it.
      { name: 'Prequalification', scope: 'Complete and return the selection questionnaire', feeMinor: 100_000 },
      { name: 'Tender', scope: 'Write and return the full tender submission', feeMinor: 200_000 },
    ],
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
});

const pqq = (overrides: Partial<Parameters<typeof bids.createBid>[1]> = {}) =>
  bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'National Grid Electricity Transmission',
    scheme: 'SQ_PA23',
    stage: 'PQQ',
    deadline: '2027-03-01',
    clarificationDeadline: '2027-02-10',
    ...overrides,
  });

describe('a stage is on the record, and the default is honest', () => {
  it('defaults to one stage rather than guessing', () => {
    const single = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'UVDB',
      rolling: true,
    });
    // A registration, a dynamic market application and an open ITT with no
    // prequalification are all genuinely one stage. Calling them ITT would
    // imply a PQQ that never happened.
    assert.equal(single.stage, 'SINGLE_STAGE');
    assert.equal(single.followsBidId, undefined);
  });

  it('takes the ITT stage from the fact that it follows a PQQ', () => {
    const first = pqq();
    const second = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'ITT',
      followsBidId: first.id,
      deadline: '2027-06-01',
      clarificationDeadline: '2027-05-10',
    });
    assert.equal(second.stage, 'ITT');
    assert.equal(second.followsBidId, first.id);
    // Separate windows, which is the whole reason the stages are separate bids.
    assert.equal(first.clarificationDeadline, '2027-02-10');
    assert.equal(second.clarificationDeadline, '2027-05-10');
  });

  it('refuses a stage that contradicts the link', () => {
    const first = pqq();
    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'SQ_PA23',
          stage: 'PQQ',
          followsBidId: first.id,
          deadline: '2027-06-01',
        }),
      'BID_ON_STAGE_CONTRADICTS',
    );
  });

  it('refuses following something that is not a prequalification', () => {
    const single = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'ITT',
      deadline: '2027-06-01',
    });
    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'ITT',
          followsBidId: single.id,
          deadline: '2027-09-01',
        }),
      'BID_ON_PREDECESSOR_NOT_PQQ',
    );
  });

  it('refuses following another customer’s prequalification', () => {
    // The one leak this module exists to prevent, dressed as a convenience:
    // two customers chasing one framework, and a link that would put one's
    // prequalification behind the other's tender.
    const theirs = bids.createBid(asProviderAdmin(), {
      engagementId: rivalEngagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'SQ_PA23',
      stage: 'PQQ',
      deadline: '2027-03-01',
    });
    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'ITT',
          followsBidId: theirs.id,
          deadline: '2027-06-01',
        }),
      'BID_ON_PREDECESSOR_NOT_THIS_CUSTOMER',
    );
  });

  it('refuses a question window that shuts after the buyer has read the submission', () => {
    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'ITT',
          deadline: '2027-06-01',
          clarificationDeadline: '2027-07-01',
        }),
      'BID_ON_CLARIFICATION_AFTER_RETURN',
    );
  });

  it('carries the stage and both dates onto the register', () => {
    const first = pqq();
    const row = bids.bidRegister(asProviderAdmin(), '2027-01-15').bids.find((entry) => entry.id === first.id)!;
    assert.equal(row.stage, 'PQQ');
    assert.equal(row.clarificationDeadline, '2027-02-10');
    assert.equal(row.deadline, '2027-03-01');
  });
});

describe('a clarification is a question you send, not a note you keep', () => {
  it('routes all four acts and keeps every one human', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/bid-on/bids/:bidId/clarifications'],
      ['POST', '/v1/bid-on/bids/:bidId/clarifications/:clarificationId/asked'],
      ['POST', '/v1/bid-on/bids/:bidId/clarifications/:clarificationId/answer'],
      ['POST', '/v1/bid-on/bids/:bidId/clarifications/:clarificationId/withdraw'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // A question that went to a buyer is a fact somebody is accountable for,
    // and a buyer's answer is part of the tender documents from the moment
    // they give it. The module may raise one; only a person sends it.
    for (const type of [
      'BID_ON_CLARIFICATION_RAISED',
      'BID_ON_CLARIFICATION_ASKED',
      'BID_ON_CLARIFICATION_ANSWERED',
      'BID_ON_CLARIFICATION_WITHDRAWN',
    ]) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
  });

  it('runs raised → asked → answered, keeping the buyer’s words', () => {
    const bid = pqq();
    const raised = bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'CRITICAL',
      subject: 'Parent company guarantee',
      question:
        'Clause 9 requires a parent company guarantee. We have no parent company — will a performance bond be ' +
        'accepted in its place, and at what percentage?',
    });

    assert.equal(raised.clarification.status, 'RAISED');
    assert.equal(raised.clarification.source, 'PERSON');
    assert.equal(raised.clarification.severity, 'CRITICAL');

    const asked = bids.markClarificationAsked(asProviderAdmin(), bid.id, raised.clarification.id, {
      askedOn: '2027-02-03',
      buyerReference: 'CQ-014',
    });
    assert.equal(asked.clarification.status, 'ASKED');
    assert.equal(asked.clarification.buyerReference, 'CQ-014');
    // In before the window shut, which is the only thing that makes it worth
    // having raised.
    assert.equal(asked.late, false);

    const answered = bids.recordClarificationAnswer(asProviderAdmin(), bid.id, raised.clarification.id, {
      answer:
        'A performance bond of 10% of the contract sum will be accepted in place of a parent company guarantee ' +
        'where no parent company exists. This answer is issued to all bidders.',
      answeredOn: '2027-02-06',
    });
    assert.equal(answered.clarification.status, 'ANSWERED');
    // Verbatim. A paraphrase of a buyer's answer is a new claim with nobody's
    // name on it, and this one is issued to every bidder.
    assert.match(String(answered.clarification.answer), /issued to all bidders/);

    const standing = bids.bidPosition(asProviderAdmin(), bid.id, '2027-02-08').clarificationStanding;
    assert.equal(standing.answered, 1);
    assert.equal(standing.raised, 0);
    assert.equal(standing.missed, 0);
  });

  it('records a question that went late rather than refusing it', () => {
    const bid = pqq();
    const raised = bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MAJOR',
      subject: 'Retention percentage',
      question: 'Amendment 4 raises retention to 10%. Is that figure negotiable for a subcontract of this size?',
    });

    // After the window shut. Refusing would make the honest entry impossible
    // and leave the question looking un-asked for ever; a buyer may answer a
    // late question and may not.
    const asked = bids.markClarificationAsked(asProviderAdmin(), bid.id, raised.clarification.id, {
      askedOn: '2027-02-20',
    });
    assert.equal(asked.clarification.status, 'ASKED');
    assert.equal(asked.late, true);
  });

  it('counts what was never asked once the window has shut', () => {
    const bid = pqq();
    bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MAJOR',
      subject: 'Set-off without notice',
      question: 'Amendment 7 permits set-off without prior notice. Will the buyer give notice before setting off?',
    });

    // Read before the window shuts: there is time.
    const inTime = bids.bidPosition(asProviderAdmin(), bid.id, '2027-02-01').clarificationStanding;
    assert.equal(inTime.missed, 0);
    assert.equal(inTime.daysToAsk, 9);
    assert.match(inTime.summary, /9 day\(s\) left to ask/);

    // Read after: the point can no longer be negotiated, only priced.
    const tooLate = bids.bidPosition(asProviderAdmin(), bid.id, '2027-02-20').clarificationStanding;
    assert.equal(tooLate.missed, 1);
    assert.ok(tooLate.daysToAsk !== null && tooLate.daysToAsk < 0);
    assert.match(tooLate.summary, /never asked/);
    assert.match(tooLate.summary, /priced or accepted rather than negotiated/);
  });

  it('refuses to record an answer to something nobody sent', () => {
    const bid = pqq();
    const raised = bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MINOR',
      subject: 'Format of the method statement',
      question: 'Should the method statement be returned as a PDF or in the native format?',
    });
    const refusal = throwsCode(
      () =>
        bids.recordClarificationAnswer(asProviderAdmin(), bid.id, raised.clarification.id, {
          answer: 'PDF is preferred for all returned documents on this procurement.',
        }),
      'BID_ON_CLARIFICATION_NOT_ASKED',
    );
    // The date it went is the thing a dispute about a late question turns on.
    assert.match(String(refusal.message), /the date it went/);
  });

  it('refuses to withdraw one the buyer has already answered', () => {
    const bid = pqq();
    const raised = bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MINOR',
      subject: 'Page limit on the method statement',
      question: 'Is there a page limit on the method statement, and does it include appendices?',
    });
    bids.markClarificationAsked(asProviderAdmin(), bid.id, raised.clarification.id, { askedOn: '2027-02-02' });
    bids.recordClarificationAnswer(asProviderAdmin(), bid.id, raised.clarification.id, {
      answer: 'Ten sides of A4 excluding appendices, and appendices are not scored.',
    });

    const refusal = throwsCode(
      () =>
        bids.withdrawClarification(asProviderAdmin(), bid.id, raised.clarification.id, {
          reason: 'We would rather not have drawn attention to it.',
        }),
      'BID_ON_CLARIFICATION_ANSWERED',
    );
    assert.match(String(refusal.message), /does not become un-given/);
  });

  it('refuses two questions about one subject', () => {
    const bid = pqq();
    bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MAJOR',
      subject: 'Insurance limit',
      question: 'Is the £10m public liability limit per claim or in the aggregate?',
    });
    throwsCode(
      () =>
        bids.raiseClarification(asProviderAdmin(), bid.id, {
          severity: 'MINOR',
          subject: 'Insurance limit',
          question: 'Can you confirm whether the insurance limit applies per claim?',
        }),
      'BID_ON_CLARIFICATION_DUPLICATE',
    );
  });

  it('does not raise a subject again once somebody has withdrawn it', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'ITT',
      deadline: '2027-06-01',
    });
    const recorded = bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [{ reference: 'Appendix 2', title: 'Order Form', mandatory: true, owner: 'CUSTOMER' }],
    });
    const format = recorded.bid.clarifications.find((entry) => /no stated format/.test(entry.subject))!;

    bids.withdrawClarification(asProviderAdmin(), bid.id, format.id, {
      reason: 'The ITT states PDF for every return in section 4; it is stated, just not in the appendix list.',
    });

    // The register is added to again, which is what raises these. A module
    // that put a withdrawn question back would be overruling the person who
    // withdrew it every time the page reloaded.
    const again = bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [{ reference: 'Appendix 6', title: 'Specification acknowledgement', mandatory: true, owner: 'PROVIDER' }],
    });
    const sameSubject = again.bid.clarifications.filter((entry) => entry.subject === format.subject);
    assert.equal(sameSubject.length, 1);
    assert.equal(sameSubject[0]?.status, 'WITHDRAWN');
    // Appendix 6 raises its own question, which is a different subject and a
    // genuinely new one — the withdrawal silenced that appendix, not the rule.
    assert.ok(again.bid.clarifications.some((entry) => /Appendix 6 has no stated format/.test(entry.subject)));
  });

  it('keeps the source, so a reader knows what noticed it', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'ITT',
      deadline: '2027-06-01',
    });
    bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        { section: 'About you', number: 'A1', text: 'Tell us about your organisation.', answerType: 'TEXT', mandatory: true, passFail: false },
      ],
    });
    bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [{ reference: 'Appendix 2', title: 'Order Form', mandatory: true, owner: 'CUSTOMER', signatureRequired: true }],
    });
    bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MAJOR',
      subject: 'Novation on framework call-off',
      question: 'Will the call-off contract be novated to the successful bidder, and on what terms?',
    });

    const sources = new Set(bids.requireBid(asProviderAdmin(), bid.id).clarifications.map((entry) => entry.source));
    // A reader treats "the amendments reading spotted this" differently from
    // "a colleague asked for this", so the record says which.
    assert.ok(sources.has('LIMITS'));
    assert.ok(sources.has('RETURNABLES'));
    assert.ok(sources.has('PERSON'));
  });

  it('says plainly where no clarification deadline is recorded', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'ITT',
      deadline: '2027-06-01',
    });
    bids.raiseClarification(asProviderAdmin(), bid.id, {
      severity: 'MINOR',
      subject: 'Portal upload limit',
      question: 'Is there a file size limit on the portal upload for the supporting documents?',
    });
    const standing = bids.bidPosition(asProviderAdmin(), bid.id).clarificationStanding;
    assert.equal(standing.daysToAsk, null);
    // Not knowing when the window shuts is itself the finding.
    assert.match(standing.summary, /almost always well before the return/);
  });
});
