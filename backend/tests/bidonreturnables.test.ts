import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as engine from '../src/domain/bidon/engine.ts';
import { packReadiness, verdictFor, type CriterionScores } from '../src/domain/bidon/rubric.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { AIProvider } from '../src/goldenthread/types.ts';
import type { AIProviderAdapter, ProviderRequest } from '../src/ai/providers/types.ts';

/**
 * The half of a submission that is not answers.
 *
 * ## The failure this closes
 *
 * A measured term contract arrives as nine documents. Three carry questions;
 * five are obligations with no question attached — an order form to complete
 * and sign, a cost model to price, a schedule of amendments to accept or
 * qualify, a stock list, a specification. A submission missing a signed order
 * form is rejected exactly as completely as one missing an answer.
 *
 * Before this, readiness on such a pack read **100% with the order form
 * unsigned**, because readiness was about answers and nothing in the module
 * knew those documents existed as obligations. That is the most expensive kind
 * of wrong available here: confidently wrong at the one moment nobody
 * re-checks.
 *
 * ## And the two smaller ones beside it
 *
 * **An unstated limit is a question, not a free hand.** The standard section
 * raises clarifications for dates on its own; nothing raised them for limits,
 * so a portal box with no stated limit was answered at whatever length somebody
 * felt like.
 *
 * **An amended standard form is a different contract.** The reading is a model
 * call that produces questions for the buyer and observations for whoever
 * advises the customer — it accepts nothing and advises on nothing, which the
 * tests below pin down as hard as the rest.
 *
 * Everything here is additive: the first suite asserts that a pack with no
 * returnables behaves exactly as it did before they existed.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const DEADLINE = '2027-06-01';

const REASONS: Record<string, string> = {
  COMPLIANCE: 'Every part of the question is answered in the order asked',
  EVIDENCE: 'Each claim is cited to an in-date item',
  BUYER_RELEVANCE: 'Framed for a social landlord and the scheme',
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

let customer: customers.CustomerAccount;
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

  customer = customers.openCustomer(asProviderAdmin(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
  engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: customer.id,
    name: 'EPC measured term contract',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 180_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);

  policy = evidence.recordExtraction(
    asProviderAdmin(),
    evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: customer.id,
      type: 'POLICY',
      title: 'Domestic access and no-access procedure',
      hash: `sha256:${'a'.repeat(64)}`,
    }).id,
    {
      extractedText: ['Our no-access procedure runs to three attempts and a recorded letter.'],
      chunks: [
        {
          pageRef: 'page 2',
          text:
            'Where an operative cannot gain access we make three attempts at different times of day, leave a card ' +
            'on each, and issue a recorded letter before the property is returned to the client as no-access.',
        },
      ],
    },
  );
});

/** A bid with one mandatory text question, answered and approved. */
function readyBid(): bids.Bid {
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'Calderdale Homes',
    scheme: 'ITT',
    deadline: DEADLINE,
  });
  bids.confirmQuestions(asProviderAdmin(), bid.id, {
    questions: [
      {
        section: 'Access',
        number: 'Q1',
        text: 'Describe your no-access process for occupied domestic properties.',
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
    body: ['Three attempts at different times of day, a card each time, then a recorded letter.'],
    citations: [{ evidenceId: policy.id, chunkId: policy.chunks[0]!.id }],
  });
  bids.scoreAnswer(asProviderAdmin(), bid.id, written.answer.id, { scores: FULL, reasons: REASONS });
  bids.approveAnswer(asProviderAdmin(), bid.id, written.answer.id, {
    note: 'Read against the procedure on file; the three attempts and the letter match.',
  });
  return bids.requireBid(asProviderAdmin(), bid.id);
}

describe('it is additive: a pack with no returnables is unchanged', () => {
  it('reads and exports exactly as it did before they existed', () => {
    const bid = readyBid();
    const position = bids.bidPosition(asProviderAdmin(), bid.id);

    assert.deepEqual(position.returnables, []);
    assert.deepEqual(position.readiness.returnablesOutstanding, []);
    assert.equal(position.readiness.exportable, true);
    // The summary says nothing about returnables on a pack that has none.
    assert.doesNotMatch(position.readiness.summary, /returnable/);

    const exported = bids.exportBid(asProviderAdmin(), bid.id);
    assert.equal(exported.bid.status, 'EXPORTED');
  });

  it('leaves packReadiness identical when called with one argument', () => {
    // Scored, so the answer is green and the pack is genuinely exportable —
    // otherwise the identity below would hold trivially with both refusing.
    const verdict = verdictFor({
      scores: FULL,
      answered: true,
      mandatory: true,
      passFail: false,
      words: 10,
      deadline: DEADLINE,
      citations: [],
      declarations: [],
    });
    const one = packReadiness([{ mandatory: true, approved: true, verdict }]);
    const two = packReadiness([{ mandatory: true, approved: true, verdict }], []);
    assert.deepEqual(one, two);
    assert.equal(one.exportable, true);
  });
});

describe('the register is wired in, and no agent supplies a document', () => {
  it('routes all four acts', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/bid-on/bids/:bidId/returnables'],
      ['POST', '/v1/bid-on/bids/:bidId/returnables/:returnableId/supplied'],
      ['POST', '/v1/bid-on/bids/:bidId/returnables/:returnableId/waive'],
      ['POST', '/v1/bid-on/bids/:bidId/amendments'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }
  });

  it('keeps the register human and lets a model only read a contract', () => {
    // Recording the register is a person reading nine documents; saying a
    // signed order form exists is a statement somebody is accountable for; and
    // waiving one removes a gate, which is a decision.
    for (const type of [
      'BID_ON_RETURNABLES_RECORDED',
      'BID_ON_RETURNABLE_SUPPLIED',
      'BID_ON_RETURNABLE_WAIVED',
    ]) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
    // The amendments reading genuinely is authored by a model, and it decides
    // nothing — so it is the one of the four that an agent may write.
    assert.equal(lookupEventType('BID_ON_AMENDMENTS_REVIEWED')?.aiAllowed, true);
    // A waiver is recorded as an approval, not an update.
    assert.equal(lookupEventType('BID_ON_RETURNABLE_WAIVED')?.action, 'APPROVE');
  });
});

describe('an unsigned order form stops a pack that is 100% on answers', () => {
  let bid: bids.Bid;

  before(() => {
    bid = readyBid();
    bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [
        {
          reference: 'Appendix 2',
          title: 'JCT MTC 2024 Order Form',
          mandatory: true,
          owner: 'CUSTOMER',
          format: 'Signed original, scanned to PDF',
          signatureRequired: true,
          internalDueBy: '2027-05-20',
        },
        {
          reference: 'Appendix 5',
          title: 'EPC Cost Model, priced',
          mandatory: true,
          owner: 'CUSTOMER',
          format: 'Native spreadsheet',
          internalDueBy: '2027-05-18',
        },
        {
          reference: 'Appendix 7',
          title: 'Contractor’s Code of Conduct acknowledgement',
          mandatory: false,
          owner: 'PROVIDER',
        },
      ],
    });
    bid = bids.requireBid(asProviderAdmin(), bid.id);
  });

  it('is the exact failure this closes: every answer approved, pack not sendable', () => {
    const position = bids.bidPosition(asProviderAdmin(), bid.id);

    // The answers half is perfect and says so.
    assert.deepEqual(position.readiness.blocking, []);
    assert.equal(position.readiness.approved, 1);
    assert.equal(position.readiness.red, 0);

    // And the pack cannot go, for the two mandatory documents.
    assert.equal(position.readiness.exportable, false);
    assert.equal(position.readiness.returnablesOutstanding.length, 2);
    assert.deepEqual(
      position.readiness.returnablesOutstanding.map((entry) => entry.reference).sort(),
      ['Appendix 2', 'Appendix 5'],
    );
    // The optional one is outstanding and does not gate — an optional document
    // left out is a decision, not a defect.
    assert.equal(position.returnables.filter((entry) => entry.status === 'OUTSTANDING').length, 3);
    assert.match(position.readiness.summary, /Every mandatory answer is approved/);
    assert.match(position.readiness.summary, /mandatory returnable\(s\) are outstanding/);
  });

  it('names the bidding company on a customer-owned returnable, not "the customer"', () => {
    // On a live tender "waiting on the customer" read as a contradiction: the
    // reader took "customer" for the buyer and could not see why anyone outside
    // the bid would be supplying part of it. The reason now names the bidding
    // company and says plainly the bid team cannot produce it in their place.
    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    const order = position.readiness.returnablesOutstanding.find((entry) => entry.reference === 'Appendix 2')!;
    assert.match(order.reason, /Thornhill Electrical Services Ltd/);
    assert.match(order.reason, /not the bid team/i);
    assert.doesNotMatch(order.reason, /Waiting on the customer/);
    // The same documents appear in the gate blockers, in the same plain words,
    // so the client meets the fact once and said one way.
    const blocker = position.readiness.gate.blockers.find((entry) => entry.reference === 'Appendix 2')!;
    assert.match(blocker.what, /Thornhill Electrical Services Ltd/);
    // And they are a step in the "do this next" guide (not yet reached here).
    const returnableStep = position.nextSteps.find((step) => /Return the required documents/.test(step.title))!;
    assert.notEqual(returnableStep.state, 'DONE');
  });

  it('refuses the export naming the documents rather than the answers', () => {
    const refusal = throwsCode(() => bids.exportBid(asProviderAdmin(), bid.id), 'BID_ON_NOT_EXPORTABLE');
    const message = String(refusal.message);
    assert.match(message, /Appendix 2/);
    assert.match(message, /Appendix 5/);
    // A gate that said "mandatory answers are red" when the real problem was an
    // unsigned order form would send somebody to re-read answers that are fine.
    assert.doesNotMatch(message, /mandatory answer\(s\) are red/);
  });

  it('exports once the two mandatory ones are accounted for, one supplied and one waived', () => {
    const order = bid.returnables.find((entry) => entry.reference === 'Appendix 2')!;
    const cost = bid.returnables.find((entry) => entry.reference === 'Appendix 5')!;

    bids.supplyReturnable(asProviderAdmin(), bid.id, order.id, {
      evidenceId: policy.id,
      note: 'Signed by the director on 14 May and scanned.',
    });
    // Still blocked on the other one — one at a time, not all or nothing.
    assert.equal(bids.bidPosition(asProviderAdmin(), bid.id).readiness.exportable, false);

    bids.waiveReturnable(asProviderAdmin(), bid.id, cost.id, {
      reason: 'Buyer confirmed by clarification on 12 May that pricing is submitted through the portal instead.',
    });

    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    assert.equal(position.readiness.exportable, true);
    assert.match(position.readiness.summary, /All 3 returnable\(s\) are accounted for/);
    assert.equal(bids.exportBid(asProviderAdmin(), bid.id).bid.status, 'EXPORTED');
  });
});

describe('the register refuses what would make it useless', () => {
  let bid: bids.Bid;
  before(() => {
    bid = readyBid();
    bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [{ reference: 'Appendix 2', title: 'Order Form', mandatory: true, owner: 'CUSTOMER' }],
    });
  });

  it('refuses a reference it already holds', () => {
    const refusal = throwsCode(
      () =>
        bids.recordReturnables(asProviderAdmin(), bid.id, {
          returnables: [{ reference: 'appendix 2', title: 'Order Form again', mandatory: true, owner: 'PROVIDER' }],
        }),
      'BID_ON_RETURNABLE_DUPLICATE',
    );
    assert.match(String(refusal.message), /two things a reviewer has to check separately/);
  });

  it('refuses an internal date after the buyer’s return date', () => {
    throwsCode(
      () =>
        bids.recordReturnables(asProviderAdmin(), bid.id, {
          returnables: [
            {
              reference: 'Appendix 6',
              title: 'EPC Specification acknowledgement',
              mandatory: true,
              owner: 'PROVIDER',
              internalDueBy: '2027-07-01',
            },
          ],
        }),
      'BID_ON_INTERNAL_DATE_AFTER_RETURN',
    );
  });

  it('refuses a returnable pointing at another customer’s evidence', () => {
    const rival = customers.openCustomer(asProviderAdmin(), { legalName: 'Calder Civils Ltd' });
    const theirs = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: rival.id,
      type: 'POLICY',
      title: 'Their own procedure',
      hash: `sha256:${'b'.repeat(64)}`,
    });
    const held = bids.requireBid(asProviderAdmin(), bid.id).returnables[0]!;
    throwsCode(
      () => bids.supplyReturnable(asProviderAdmin(), bid.id, held.id, { evidenceId: theirs.id }),
      'BID_ON_EVIDENCE_NOT_THIS_CUSTOMER',
    );
  });

  it('does not let the bid writer waive one', () => {
    const held = bids.requireBid(asProviderAdmin(), bid.id).returnables[0]!;
    // Waiving removes a gate, so it sits with approval — and the QS holds
    // authorship on BID_SERVICES without it, by role as well as by act.
    throwsCode(
      () => bids.waiveReturnable(asBidWriter(), bid.id, held.id, { reason: 'Not needed for this submission at all.' }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a waiver with no reason worth reading', () => {
    const held = bids.requireBid(asProviderAdmin(), bid.id).returnables[0]!;
    throwsCode(
      () => bids.waiveReturnable(asProviderAdmin(), bid.id, held.id, { reason: 'n/a' }),
      'BID_ON_REASON_TOO_SHORT',
    );
  });

  it('refuses supplying one twice', () => {
    const held = bids.requireBid(asProviderAdmin(), bid.id).returnables[0]!;
    bids.supplyReturnable(asProviderAdmin(), bid.id, held.id, { note: 'Signed and scanned.' });
    throwsCode(
      () => bids.supplyReturnable(asProviderAdmin(), bid.id, held.id, { note: 'Again' }),
      'BID_ON_RETURNABLE_SUPPLIED',
    );
  });
});

describe('an unstated length limit becomes a question for the buyer', () => {
  it('raises one clarification for the lot, not one per question', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Calderdale Homes',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    const confirmedPack = bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        // The portal's "About You" box: no limit stated anywhere.
        { section: 'About you', number: 'A1', text: 'Tell us about your organisation.', answerType: 'TEXT', mandatory: true, passFail: false },
        { section: 'About you', number: 'A2', text: 'Describe your relevant experience.', answerType: 'TEXT', mandatory: true, passFail: false },
        // Stated, so nothing to ask.
        { section: 'Access', number: 'Q1', text: 'Describe your no-access process.', answerType: 'TEXT', wordLimit: 500, mandatory: true, passFail: false },
        // No length to limit, so no question worth asking.
        { section: 'Insurance', number: 'Q2', text: 'Do you hold employers’ liability cover?', answerType: 'YES_NO', mandatory: true, passFail: true },
      ],
    });

    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    void confirmedPack;
    assert.equal(position.clarifications.length, 1, 'one clarification for the lot, or nobody reads the list');
    const raised = position.clarifications[0]!;
    assert.match(raised.subject, /2 question\(s\) state no length limit/);
    assert.match(raised.question, /A1, A2/);
    assert.doesNotMatch(raised.question, /Q1|Q2/);
    // The standing, not a bare count: one to ask, nothing asked, and — on this
    // bid — no clarification deadline recorded, which is itself worth saying
    // because nothing then knows when the window shuts.
    assert.equal(position.clarificationStanding.raised, 1);
    assert.equal(position.clarificationStanding.asked, 0);
    assert.equal(position.clarificationStanding.daysToAsk, null);
    assert.match(position.clarificationStanding.summary, /No clarification deadline is recorded/);
    assert.ok(position.limits.some((line) => /No clarification deadline is recorded/.test(line)));
    assert.equal(position.clarifications[0]?.status, 'RAISED');
    assert.equal(position.clarifications[0]?.source, 'LIMITS');
  });

  it('raises nothing where every limit is stated', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Calderdale Homes',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        { section: 'Access', number: 'Q1', text: 'Describe your no-access process.', answerType: 'TEXT', wordLimit: 500, mandatory: true, passFail: false },
      ],
    });
    assert.deepEqual(bids.requireBid(asProviderAdmin(), bid.id).clarifications, []);
  });

  it('asks about a signature with no internal date, and about an unstated format', () => {
    const bid = readyBid();
    const result = bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [
        { reference: 'Appendix 2', title: 'Order Form to be signed', mandatory: true, owner: 'CUSTOMER', signatureRequired: true },
      ],
    });
    const subjects = result.clarifications.map((entry) => entry.subject);
    assert.ok(subjects.some((subject) => /needs a signature and has no internal date/.test(subject)));
    assert.ok(subjects.some((subject) => /has no stated format/.test(subject)));
    // A signature is a lead time rather than a task, so it is not a minor note.
    assert.equal(result.clarifications.find((entry) => /signature/.test(entry.subject))?.severity, 'MAJOR');
  });
});

describe('the amendments reading asks questions and decides nothing', () => {
  /** A reasoning adapter that answers with a fixed reading of an amended JCT. */
  function reader(name: AIProvider, body: Record<string, unknown>): AIProviderAdapter {
    return {
      name,
      capability: 'REASONING',
      multimodal: true,
      // Accurate: it opens no socket, so there is no vendor contract for a
      // clearance to be a statement about.
      transmits: false,
      healthy: () => true,
      estimateCostMinor: () => 10,
      execute: async (_request: ProviderRequest) => ({
        provider: name,
        modelClass: 'reasoning-standard',
        output: body,
        rawCostMinor: 10,
        latencyMs: 1,
      }),
    };
  }

  async function withReader(body: Record<string, unknown>) {
    const host = new Platform(new AIOrchestrator({ reasoning: reader('OPENAI', body) }));
    const s = await seedDemoProject(host);
    host.setModuleGrant({
      moduleId: 'BID_ON',
      tenantId: s.tenantId,
      status: 'ACTIVE',
      reason: 'Allocated under the signed Bid-On agreement',
      agreementRef: 'AGR-BIDON-2026-001',
      decidedBy: s.users.operator!.id,
    });
    const admin = host.context(s.users.owner!.auth, `${s.tenantId}-governance`, { source: 'WEB' });
    const account = customers.openCustomer(admin, { legalName: 'Thornhill Electrical Services Ltd' });
    const deal = engagements.openEngagement(admin, {
      customerAccountId: account.id,
      name: 'EPC measured term contract',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 180_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(admin, deal.id);
    const bid = bids.createBid(admin, {
      engagementId: deal.id,
      buyerName: 'Calderdale Homes',
      scheme: 'ITT',
      deadline: DEADLINE,
    });
    return { host, admin, bidId: bid.id };
  }

  it('lands the questions on the bid beside the ones the question list raised', async () => {
    const { admin, bidId } = await withReader({
      clarifications: [
        {
          severity: 'CRITICAL',
          subject: 'Clause 4.9 removes the liability cap',
          question:
            'Amendment 12 deletes the cap on the contractor’s liability. Is the buyer willing to reinstate a cap, ' +
            'and at what figure? An uncapped liability cannot be insured on this contract value.',
        },
        { severity: 'MAJOR', subject: 'Payment period extended to 60 days', question: 'Is the 60-day period negotiable?' },
      ],
      observations: [
        'Amendment 12 deletes clause 4.9 in full, which is the liability cap in the unamended form.',
        'Amendment 18 extends the final date for payment from 21 to 60 days from the due date.',
      ],
    });

    const result = await engine.reviewAmendments(admin, platform.evidence, bidId, {
      text: 'A'.repeat(300),
      contractForm: 'JCT Measured Term Contract 2024',
    });

    assert.equal(result.clarifications.length, 2);
    assert.equal(result.observations.length, 2);
    assert.ok(result.acuConsumed > 0);

    const position = bids.bidPosition(admin, bidId);
    assert.equal(position.clarifications.length, 2);
    assert.equal(position.clarifications[0]?.severity, 'CRITICAL');
    // The reading is on the record with the model that wrote it, because a
    // first pass by a model is a different thing from one by a person.
    assert.equal(position.bid.amendmentsReview?.provider, 'OPENAI');
    assert.equal(position.bid.amendmentsReview?.contractForm, 'JCT Measured Term Contract 2024');
    assert.equal(position.bid.amendmentsReview?.observations.length, 2);
  });

  it('does not accept, qualify or change a single thing about the bid', async () => {
    const { admin, bidId } = await withReader({
      clarifications: [{ severity: 'MAJOR', subject: 'Set-off without notice', question: 'Will the buyer give notice?' }],
      observations: ['Amendment 7 permits set-off without prior notice.'],
    });

    const before = bids.requireBid(admin, bidId);
    await engine.reviewAmendments(admin, platform.evidence, bidId, { text: 'A'.repeat(300) });
    const after = bids.requireBid(admin, bidId);

    // Everything that decides anything is untouched: the status, the questions,
    // the answers, the returnables and the export gate.
    assert.equal(after.status, before.status);
    assert.deepEqual(after.questions, before.questions);
    assert.deepEqual(after.answers, before.answers);
    assert.deepEqual(after.returnables, before.returnables);
  });

  it('keeps a finding whose severity it could not read, as MAJOR', async () => {
    const { admin, bidId } = await withReader({
      clarifications: [{ severity: 'EXTREMELY BAD', subject: 'Fitness for purpose implied', question: 'Is this intended?' }],
      observations: [],
    });
    const result = await engine.reviewAmendments(admin, platform.evidence, bidId, { text: 'A'.repeat(300) });
    // Dropped, it would make the reading look cleaner than it was; a point
    // worth raising is worth asking even where the label was wrong.
    assert.equal(result.clarifications.length, 1);
    assert.equal(result.clarifications[0]?.severity, 'MAJOR');
  });

  it('refuses an empty reading rather than recording one', async () => {
    const { admin, bidId } = await withReader({ clarifications: [], observations: [] });
    await rejectsCode(() => engine.reviewAmendments(admin, platform.evidence, bidId, { text: 'A'.repeat(300) }), 'BID_ON_NOTHING_READ');
  });

  it('refuses to run with nothing to read', async () => {
    const { admin, bidId } = await withReader({ clarifications: [], observations: [] });
    await rejectsCode(() => engine.reviewAmendments(admin, platform.evidence, bidId, {}), 'BID_ON_NOTHING_TO_REVIEW');
  });

  it('does not merge the same subject twice on a second reading', async () => {
    const { admin, bidId } = await withReader({
      clarifications: [{ severity: 'MAJOR', subject: 'Set-off without notice', question: 'Will the buyer give notice?' }],
      observations: ['Amendment 7 permits set-off without prior notice.'],
    });
    const first = await engine.reviewAmendments(admin, platform.evidence, bidId, { text: 'A'.repeat(300) });
    assert.equal(first.recorded, true);

    const again = await engine.reviewAmendments(admin, platform.evidence, bidId, { text: 'A'.repeat(400) });
    // A list that repeated the same point every time somebody re-read a longer
    // version of the schedule is a list nobody reads to the end.
    assert.equal(bids.bidPosition(admin, bidId).clarifications.length, 1);
    // Nothing was written, because nothing was new — but the findings still
    // come back and the run is still reported as charged. Refusing would lose
    // the caller the result of a call they have already paid for, and writing
    // would put an event on the ledger whose only content is that somebody
    // pressed the button twice.
    assert.equal(again.recorded, false);
    assert.equal(again.clarifications.length, 1);
    assert.ok(again.acuConsumed > 0);
  });
});

describe('the customer’s own documents go in the request that goes to them', () => {
  it('counts them on the register, split from the provider’s own', () => {
    const bid = readyBid();
    bids.recordReturnables(asProviderAdmin(), bid.id, {
      returnables: [
        { reference: 'Appendix 5', title: 'EPC Cost Model, priced', mandatory: true, owner: 'CUSTOMER' },
        { reference: 'Appendix 2', title: 'Order Form, signed', mandatory: true, owner: 'CUSTOMER' },
        { reference: 'Appendix 7', title: 'Code of Conduct acknowledgement', mandatory: true, owner: 'PROVIDER' },
      ],
    });

    const row = bids.bidRegister(asProviderAdmin()).bids.find((entry) => entry.id === bid.id)!;
    assert.equal(row.returnablesOutstanding, 3);
    // Split out, because the customer's own screen shows what is waiting on
    // *them*, and lumping in the provider's own documents would tell a
    // contractor they are late for something nobody asked them for.
    assert.equal(row.returnablesWithCustomer, 2);
  });
});
