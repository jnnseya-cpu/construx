import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import { DEFAULT_QUALITY_FLOOR, type CriterionScores } from '../src/domain/bidon/rubric.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * The quality floor, Bid-On side.
 *
 * A scored answer that reads below the bar refuses the export the same way a red
 * one does, but it is a **soft** block: a named reviewer can record a reason and
 * let it through, because a genuinely unreachable mark must not trap a
 * legitimate bid. The default is 80 — the green band — and a bid may set its
 * own. These tests pin the four behaviours the product owner asked for: a
 * below-floor answer blocks and is named, an override-with-reason then clears
 * it, a pack at or above the floor exports clean, and a per-bid floor is
 * respected. The override mechanism is honest about what it is — the gate holds
 * the answer to the mark this rubric can find, which a buyer's own scorer may
 * still read differently.
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

/** A flat mark across the five criteria, so the weighted score is exactly it. */
const flat = (value: number): CriterionScores => ({
  COMPLIANCE: value,
  EVIDENCE: value,
  BUYER_RELEVANCE: value,
  SPECIFICITY: value,
  CLARITY_AND_LIMITS: value,
});

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

/**
 * A bid with one mandatory question, answered, scored at `score` and approved.
 *
 * Approved by the provider admin rather than the writer, so the two-person
 * check is satisfied and the only thing left between the pack and export is the
 * floor — which is what these tests are about.
 */
function bidAt(score: number, options: { qualityFloorPercent?: number } = {}): { bidId: string; answerId: string; number: string } {
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'Calderdale Homes',
    scheme: 'ITT',
    deadline: DEADLINE,
    ...(options.qualityFloorPercent === undefined ? {} : { qualityFloorPercent: options.qualityFloorPercent }),
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
  bids.scoreAnswer(asProviderAdmin(), bid.id, written.answer.id, { scores: flat(score), reasons: REASONS });
  bids.approveAnswer(asProviderAdmin(), bid.id, written.answer.id, {
    note: 'Read against the procedure on file; the three attempts and the letter match.',
  });
  return { bidId: bid.id, answerId: written.answer.id, number: question.number };
}

describe('the floor is wired in and is a human decision', () => {
  it('routes the setter and the override', () => {
    for (const pattern of [
      '/v1/bid-on/bids/:bidId/quality-floor',
      '/v1/bid-on/bids/:bidId/answers/:answerId/floor-override',
    ]) {
      assert.ok(
        ROUTES.some((route) => route.method === 'POST' && route.pattern === pattern),
        `${pattern} has no route`,
      );
    }
  });

  it('keeps both acts out of an agent’s reach', () => {
    // Lowering the bar and accepting a below-floor answer are commercial
    // decisions, not a model's to take.
    assert.notEqual(lookupEventType('BID_ON_QUALITY_FLOOR_SET')?.aiAllowed, true);
    assert.notEqual(lookupEventType('BID_ON_ANSWER_FLOOR_OVERRIDDEN')?.aiAllowed, true);
  });

  it('defaults a new bid to the green floor, on the record', () => {
    const { bidId } = bidAt(90);
    assert.equal(bids.requireBid(asProviderAdmin(), bidId).qualityFloorPercent, DEFAULT_QUALITY_FLOOR);
  });
});

describe('a scored answer below the floor blocks the export and is named', () => {
  it('refuses, names the question, and offers the two ways on', () => {
    const { bidId, number } = bidAt(60);

    const position = bids.bidPosition(asProviderAdmin(), bidId);
    assert.equal(position.readiness.exportable, false);
    const block = position.readiness.blocking.find((entry) => entry.belowFloor);
    assert.ok(block, 'the below-floor answer is not in the blocking list');
    assert.match(block.reason, /below the quality floor of 80%/);
    assert.equal(block.requirementUnmet, false, 'a floor block is soft, not a requirement wall');

    const error = throwsCode(() => bids.exportBid(asProviderAdmin(), bidId), 'BID_ON_NOT_EXPORTABLE');
    assert.match(String(error.message), new RegExp(number));
    assert.match(String(error.message), /quality floor/);
    assert.match(String(error.message), /record a reason/);
  });
});

describe('an override-with-reason then lets it through', () => {
  it('records who and why, and the pack becomes exportable', () => {
    const { bidId, answerId } = bidAt(60);

    const overridden = bids.overrideQualityFloor(asProviderAdmin(), bidId, answerId, {
      reason: 'A 4/5 is unreachable on this question for a firm our size; the answer is as strong as the evidence allows.',
    });
    assert.equal(overridden.answer.floorOverride?.by, asProviderAdmin().auth.actorId);
    assert.equal(overridden.answer.floorOverride?.floorPercent, 80);
    assert.match(String(overridden.answer.floorOverride?.reason), /unreachable/);

    const position = bids.bidPosition(asProviderAdmin(), bidId);
    assert.equal(position.readiness.exportable, true, `still blocked: ${JSON.stringify(position.readiness.blocking)}`);
    assert.equal(bids.exportBid(asProviderAdmin(), bidId).bid.status, 'EXPORTED');
  });

  it('wants a reason of substance, not a tick', () => {
    const { bidId, answerId } = bidAt(60);
    throwsCode(
      () => bids.overrideQualityFloor(asProviderAdmin(), bidId, answerId, { reason: 'ok' }),
      'BID_ON_FLOOR_REASON_REQUIRED',
    );
  });

  it('refuses to override twice', () => {
    const { bidId, answerId } = bidAt(60);
    bids.overrideQualityFloor(asProviderAdmin(), bidId, answerId, {
      reason: 'Accepted below the floor on a considered reading of what the evidence can support.',
    });
    throwsCode(
      () =>
        bids.overrideQualityFloor(asProviderAdmin(), bidId, answerId, {
          reason: 'A second attempt to record the same decision.',
        }),
      'BID_ON_FLOOR_OVERRIDDEN',
    );
  });

  it('cannot clear a red, and cannot be recorded on an answer already at the floor', () => {
    // A red is a sub-amber score or a hard rule — a redraft, not a note.
    const red = bidAt(30);
    throwsCode(
      () =>
        bids.overrideQualityFloor(asProviderAdmin(), red.bidId, red.answerId, {
          reason: 'Trying to wave a red answer through, which the floor override must not do.',
        }),
      'BID_ON_FLOOR_RED',
    );

    // A green answer meets the floor already — there is nothing to override.
    const green = bidAt(90);
    throwsCode(
      () =>
        bids.overrideQualityFloor(asProviderAdmin(), green.bidId, green.answerId, {
          reason: 'Recording an override on an answer that does not need one.',
        }),
      'BID_ON_FLOOR_NOT_BELOW',
    );
  });
});

describe('a pack at or above the floor exports clean', () => {
  it('needs no override and names no floor block', () => {
    const { bidId } = bidAt(90);
    const position = bids.bidPosition(asProviderAdmin(), bidId);
    assert.equal(position.readiness.exportable, true);
    assert.equal(position.readiness.blocking.filter((entry) => entry.belowFloor).length, 0);
    assert.equal(bids.exportBid(asProviderAdmin(), bidId).bid.status, 'EXPORTED');
  });
});

describe('a per-bid floor is respected', () => {
  it('lets a 60 through when the bid’s floor is 50', () => {
    const { bidId } = bidAt(60, { qualityFloorPercent: 50 });
    const position = bids.bidPosition(asProviderAdmin(), bidId);
    assert.equal(position.readiness.exportable, true);
    assert.equal(position.readiness.blocking.length, 0);
  });

  it('blocks a 90 when the bid’s floor is raised to 95, and the block names 95%', () => {
    const { bidId, number } = bidAt(90, { qualityFloorPercent: 95 });
    const position = bids.bidPosition(asProviderAdmin(), bidId);
    assert.equal(position.readiness.exportable, false);
    const block = position.readiness.blocking.find((entry) => entry.belowFloor);
    assert.ok(block);
    assert.match(block.reason, /below the quality floor of 95%/);
    assert.match(String(throwsCode(() => bids.exportBid(asProviderAdmin(), bidId), 'BID_ON_NOT_EXPORTABLE').message), new RegExp(number));
  });

  it('respects the floor set after creation, and refuses a floor out of range', () => {
    const { bidId } = bidAt(60);
    assert.equal(bids.bidPosition(asProviderAdmin(), bidId).readiness.exportable, false);

    bids.setBidQualityFloor(asProviderAdmin(), bidId, { floorPercent: 50 });
    assert.equal(bids.requireBid(asProviderAdmin(), bidId).qualityFloorPercent, 50);
    assert.equal(bids.bidPosition(asProviderAdmin(), bidId).readiness.exportable, true);

    throwsCode(() => bids.setBidQualityFloor(asProviderAdmin(), bidId, { floorPercent: 120 }), 'BID_ON_FLOOR_RANGE');
  });
});
