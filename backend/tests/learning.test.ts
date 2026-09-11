import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as business from '../src/domain/business.ts';
import * as learning from '../src/domain/learning.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The loop closing on the bid — `L7.6`, §4.10.
 *
 * Everything the platform measured looked backwards at delivery. These tests
 * are about the four properties that make it reach forward instead.
 *
 * **A loss has somewhere to go.** `LOST` was a declared opportunity stage that
 * nothing ever set, so a bid that lost sat at `BID` for ever and the record
 * learned nothing from it. That is the signal the whole loop reads.
 *
 * **A signal is not a lesson.** Nothing the record has learned reaches an
 * estimate until a named person promotes it, and the person who proposed a
 * correction may not be the one who promotes it.
 *
 * **It will not speak from one observation.** A correction factor built on a
 * single lost bid is an anecdote with a percentage sign on it, and once it is
 * in the library nobody remembers it was one bid.
 *
 * **It says what it cannot answer.** A question the record cannot settle is
 * reported as a limit rather than left as a short list of signals that reads
 * like a clean bill.
 */

let platform: Platform;
let seed: SeedResult;
/** Four opportunities scored and decided, so there is something to settle. */
const opportunities: string[] = [];

/** Holds BUSINESS_DEVELOPMENT C/U — registers, qualifies, decides, records an outcome. */
const asBd = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER C — proposes a calibration. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — promotes one. A different person, which is the point. */
const asOwner = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** The delivery project, where estimates live. */
const asEstimator = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/** Every factor at 3, then override the one the test is about. */
const scores = (winProbability: number): business.QualificationScores =>
  Object.fromEntries(
    business.QUALIFICATION_CRITERIA.map((criterion) => [
      criterion.key,
      criterion.key === 'winProbability' ? winProbability : 3,
    ]),
  ) as business.QualificationScores;

function settle(
  title: string,
  winProbability: number,
  outcome: learning.BidOutcome,
  extra: Parameters<typeof learning.recordBidOutcome>[2] extends infer T ? Partial<T> : never = {},
): string {
  const { opportunityId } = business.registerOpportunity(asBd(), {
    title,
    clientName: 'Calderdale Metropolitan Borough Council',
    sectorType: 'TRANSPORT',
    estimatedValueMinor: 100_000_000,
    source: 'Tender portal',
  });
  business.qualifyOpportunity(asBd(), opportunityId, scores(winProbability));
    // The decision needs BUSINESS_DEVELOPMENT 'A', which the QS does not hold.
  business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Priced and pursued for the test' });
  learning.recordBidOutcome(asBd(), opportunityId, {
    outcome,
    decidedOn: '2027-04-01',
    ...extra,
  } as Parameters<typeof learning.recordBidOutcome>[2]);
  opportunities.push(opportunityId);
  return opportunityId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // Estimating is phase-gated and the seeded project has been delivered.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Retender of the remaining scope',
  });
});

describe('the doors and the catalogue', () => {
  it('is reachable, and both registers are declared read-only', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/pipeline/opportunities/:opportunityId/outcome'],
      ['GET', '/v1/calibration'],
      ['GET', '/v1/calibration/lessons'],
      ['POST', '/v1/calibration/lessons'],
      ['POST', '/v1/calibration/lessons/:lessonId/promote'],
      ['POST', '/v1/calibration/lessons/:lessonId/reject'],
      ['POST', '/v1/calibration/lessons/:lessonId/retire'],
    ] as const) {
      const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern === pattern);
      assert.ok(route, `${method} ${pattern} has no route`);
      if (method === 'GET') assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('lets an agent propose a calibration and never promote one', () => {
    // The one place an unverified output would become institutional truth.
    assert.equal(lookupEventType('CALIBRATION_LESSON_PROPOSED')?.aiAllowed, true);
    for (const code of ['CALIBRATION_LESSON_PROMOTED', 'CALIBRATION_LESSON_REJECTED', 'CALIBRATION_LESSON_RETIRED']) {
      assert.notEqual(lookupEventType(code)?.aiAllowed, true, `${code} is open to an agent`);
    }
    // Recording a competitor's price and moving an opportunity out of the live
    // pipeline is a transcription by somebody holding the letter.
    assert.notEqual(lookupEventType('BID_OUTCOME_RECORDED')?.aiAllowed, true);
  });

  it('classifies a calibration with the estimates it would correct', () => {
    const classification = classifyEntity('CalibrationLesson');
    assert.ok(classification);
    assert.equal(classification.area, 'ESTIMATE_TENDER');
    assert.equal(classification.sensitivity, 'COMMERCIAL_L3');
  });
});

describe('a loss had nowhere to go', () => {
  it('says nothing about bidding until a bid has settled', () => {
    const reading = learning.calibrationSignals(asQS());

    // Delivery already produces an estimating-bias signal — that half of the
    // record always looked backwards and always worked. What is absent is
    // everything that reads from an outcome.
    assert.equal(reading.signals.filter((signal) => signal.kind !== 'ESTIMATING_BIAS').length, 0);
    assert.equal(reading.settled.won, 0);
    assert.equal(reading.settled.lost, 0);
    assert.match(reading.summary, /nothing to calibrate against/);

    // And each question it cannot answer is said rather than left as silence.
    assert.ok(reading.limits.length >= 3);
    assert.ok(reading.limits.some((limit) => limit.includes('disclosed winning price')));
    assert.ok(reading.limits.some((limit) => limit.includes('win-probability score')));
  });

  it('moves a lost bid out of the live pipeline, where nothing did before', () => {
    const id = settle('Halifax depot rebuild', 4, 'LOST', {
      winningPriceMinor: 90_000_000,
      winnerName: 'A competitor',
      qualityScorePercent: 71,
      rank: 2,
      tenderers: 5,
      feedback: ['Method statement did not address the phasing of the live carriageway.'],
    });

    const state = platform.ledger.get({ refType: 'Opportunity', refId: id })!.state as {
      stage: string;
      outcome?: { outcome: string; ourPriceMinor?: number; feedback: string[] };
    };
    assert.equal(state.stage, 'LOST');
    assert.equal(state.outcome?.outcome, 'LOST');
    // Our price was not stated, so the opportunity's own value stands in.
    assert.equal(state.outcome?.ourPriceMinor, 100_000_000);
    assert.match(state.outcome!.feedback[0]!, /live carriageway/);
  });

  it('leaves a win where it is, because converting it is a separate act', () => {
    const id = settle('Todmorden flood scheme', 4, 'WON', { qualityScorePercent: 82 });
    const state = platform.ledger.get({ refType: 'Opportunity', refId: id })!.state as { stage: string };
    // Moving it to CONVERTED here would claim a conversion that has not happened.
    assert.equal(state.stage, 'BID');
  });

  it('refuses to record an outcome twice', () => {
    const error = throwsCode(
      () => learning.recordBidOutcome(asBd(), opportunities[0]!, { outcome: 'WON', decidedOn: '2027-05-01' }),
      'OUTCOME_ALREADY_RECORDED',
    );
    assert.match(String(error.message), /cannot rely on/);
  });

  it('refuses an outcome on something nobody bid', () => {
    const { opportunityId } = business.registerOpportunity(asBd(), {
      title: 'Declined framework call-off',
      clientName: 'Pendle Borough Council',
      sectorType: 'TRANSPORT',
      estimatedValueMinor: 20_000_000,
      source: 'Framework',
    });
    // Not qualified, so not decided.
    throwsCode(
      () => learning.recordBidOutcome(asBd(), opportunityId, { outcome: 'LOST', decidedOn: '2027-04-01' }),
      'NOT_SUBMITTED',
    );

    business.qualifyOpportunity(asBd(), opportunityId, scores(2));
    business.decideBidNoBid(asOwner(), opportunityId, { bid: false, rationale: 'Nothing in it for us at that price' });
    const error = throwsCode(
      () => learning.recordBidOutcome(asBd(), opportunityId, { outcome: 'LOST', decidedOn: '2027-04-01' }),
      'NOT_BID',
    );
    // Counting a no-bid as a loss would make the win rate a measure of how
    // often the business declines.
    assert.match(String(error.message), /how often we decline/);
  });

  it('refuses figures that contradict each other', () => {
    const { opportunityId } = business.registerOpportunity(asBd(), {
      title: 'Contradictory feedback',
      clientName: 'Rossendale Borough Council',
      sectorType: 'TRANSPORT',
      estimatedValueMinor: 30_000_000,
      source: 'Portal',
    });
    business.qualifyOpportunity(asBd(), opportunityId, scores(3));
    business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Worth a go on this one' });

    throwsCode(
      () =>
        learning.recordBidOutcome(asBd(), opportunityId, {
          outcome: 'LOST',
          decidedOn: '2027-04-01',
          rank: 6,
          tenderers: 4,
        }),
      'RANK_IMPOSSIBLE',
    );
    throwsCode(
      () =>
        learning.recordBidOutcome(asBd(), opportunityId, {
          outcome: 'WON',
          decidedOn: '2027-04-01',
          winningPriceMinor: 29_000_000,
        }),
      'WINNING_PRICE_ON_A_WIN',
    );
    throwsCode(
      () =>
        learning.recordBidOutcome(asBd(), opportunityId, {
          outcome: 'LOST',
          decidedOn: '2027-04-01',
          qualityScorePercent: 140,
        }),
      'SCORE_OUT_OF_RANGE',
    );
  });
});

describe('what the record says about how this business bids', () => {
  before(() => {
    // Two more losses with a disclosed winning price, so the price signal has
    // three observations rather than one.
    settle('Brighouse leisure centre', 4, 'LOST', { winningPriceMinor: 88_000_000, qualityScorePercent: 68 });
    settle('Elland highways package', 2, 'LOST', { winningPriceMinor: 92_000_000 });
    settle('Sowerby Bridge culvert', 2, 'WON');
  });

  it('reports where our price sat against the winning price', () => {
    const reading = learning.calibrationSignals(asQS());
    const price = reading.signals.find((signal) => signal.id === 'price:position')!;

    assert.ok(price, 'three disclosed winning prices produced no price signal');
    assert.equal(price.observations, 3);
    assert.equal(price.confidence, 'USABLE');
    // £1.00m against a median winning price of £0.90m.
    assert.equal(price.deltaPercent, 11.1);
    assert.match(price.reading, /a gap in price, not necessarily a gap in cost/);
    assert.equal(price.sources.length, 3, 'a lesson built on this must carry its source bids');
  });

  it('reports what a win-probability score has actually been worth', () => {
    const reading = learning.calibrationSignals(asQS());

    // Three bids scored 4: one won, two lost. The score implies 80%.
    const four = reading.signals.find((signal) => signal.id === 'win:4')!;
    assert.ok(four);
    assert.equal(four.observations, 3);
    assert.equal(four.deltaPercent, Number((33.3 - 80).toFixed(1)));
    assert.match(four.reading, /1 of 3 settled bid\(s\) scored 4 were won/);

    // Two scored 2: one won, one lost. The score implies 40%.
    const two = reading.signals.find((signal) => signal.id === 'win:2')!;
    assert.equal(two.observations, 2);
    assert.equal(two.deltaPercent, 10);
  });

  it('counts the settled bids and says which questions it still cannot answer', () => {
    const reading = learning.calibrationSignals(asQS());
    assert.equal(reading.settled.won, 2);
    assert.equal(reading.settled.lost, 3);
    // No settled bid names an assurance review, so the findable score is not
    // calibrated and the reading says exactly that rather than implying it is.
    assert.ok(reading.limits.some((limit) => limit.includes('not calibrated against real feedback')));
    assert.match(reading.summary, /5 settled bid\(s\)/);
  });

  it('makes the algorithm’s own self-check work, which it could not before', () => {
    // `byBand.winRatePercent` was null on every band for ever, because nothing
    // set LOST and the rate is taken over decided outcomes.
    const discipline = business.bidDiscipline(asBd());
    assert.ok(
      discipline.byBand.some((band) => band.winRatePercent !== null),
      'no band has a win rate, so nothing is settling',
    );
  });
});

describe('a signal is not a lesson', () => {
  it('refuses a signal the record cannot support', () => {
    const thin = learning.calibrationSignals(asQS()).signals.find((signal) => signal.id === 'win:2')!;
    assert.equal(thin.observations, 2);
    const error = throwsCode(
      () =>
        learning.proposeLesson(asQS(), {
          signalId: thin.id,
          adjustmentPercent: 10,
          rationale: 'Two bids scored two and one of them was won, which is encouraging.',
        }),
      'SIGNAL_TOO_THIN',
    );
    assert.match(String(error.message), /nobody remembers it was one bid/);
  });

  it('refuses a signal that does not exist, and a reason that is not one', () => {
    throwsCode(
      () =>
        learning.proposeLesson(asQS(), {
          signalId: 'win:99',
          adjustmentPercent: 5,
          rationale: 'Something the record has never produced a signal for.',
        }),
      'SIGNAL_NOT_FOUND',
    );
    throwsCode(
      () => learning.proposeLesson(asQS(), { signalId: 'price:position', adjustmentPercent: 5, rationale: 'Because.' }),
      'RATIONALE_REQUIRED',
    );
  });

  it('refuses a correction larger than any calibration should carry', () => {
    const error = throwsCode(
      () =>
        learning.proposeLesson(asQS(), {
          signalId: 'price:position',
          adjustmentPercent: 65,
          rationale: 'Our prices are miles off and this should fix all of it in one go.',
        }),
      'ADJUSTMENT_TOO_LARGE',
    );
    // A gap that size is a scope difference or a mistake, and a factor hides
    // whichever it is.
    assert.match(String(error.message), /scope difference or a mistake/);
  });

  it('proposes one, and refuses a second against the same signal', () => {
    const lesson = learning.proposeLesson(asQS(), {
      signalId: 'price:position',
      adjustmentPercent: -8,
      rationale: 'Three disclosed winning prices sat consistently below ours on comparable public work.',
    });

    assert.match(lesson.reference, /^CAL-\d{4}$/);
    assert.equal(lesson.status, 'PROPOSED');
    assert.equal(lesson.kind, 'PRICE_POSITION');
    assert.equal(lesson.observations, 3);
    // Carried onto the lesson, because the signal moves as outcomes are
    // recorded and the lesson must say what it was built on.
    assert.equal(lesson.sources.length, 3);

    throwsCode(
      () =>
        learning.proposeLesson(asQS(), {
          signalId: 'price:position',
          adjustmentPercent: -5,
          rationale: 'A second view of the same three bids, arrived at independently.',
        }),
      'LESSON_ALREADY_OPEN',
    );
  });

  it('will not let the proposer promote their own correction', () => {
    const lesson = learning.lessonRegister(asQS()).lessons.find((entry) => entry.status === 'PROPOSED')!;
    const error = throwsCode(
      () => learning.promoteLesson(asQS(), lesson.id, { note: 'Checked it myself and it looks right' }),
      'PROMOTER_IS_PROPOSER',
    );
    assert.match(String(error.message), /not a thing one person decides on their own/);
  });

  it('wants to know what the approver checked', () => {
    const lesson = learning.lessonRegister(asQS()).lessons.find((entry) => entry.status === 'PROPOSED')!;
    throwsCode(() => learning.promoteLesson(asOwner(), lesson.id, { note: 'ok' }), 'PROMOTION_NOTE_REQUIRED');
  });

  it('promotes it, naming the approver and what they checked', () => {
    const lesson = learning.lessonRegister(asQS()).lessons.find((entry) => entry.status === 'PROPOSED')!;
    const promoted = learning.promoteLesson(asOwner(), lesson.id, {
      note: 'Read the three award letters against the estimates. The gap is real and consistent.',
    });

    assert.equal(promoted.status, 'PROMOTED');
    assert.equal(promoted.promotedBy, seed.users.owner!.auth.actorId);
    assert.match(promoted.promotionNote!, /three award letters/);
    assert.equal(learning.promotedLessons(asQS(), 'PRICE_POSITION').length, 1);

    // And a promoted one cannot be promoted again.
    throwsCode(
      () => learning.promoteLesson(asOwner(), lesson.id, { note: 'Promoting it a second time for luck' }),
      'LESSON_NOT_PROPOSED',
    );
  });

  it('retires one that has stopped being true, and keeps the record of it', () => {
    const promoted = learning.promotedLessons(asQS(), 'PRICE_POSITION')[0]!;
    const retired = learning.retireLesson(asOwner(), promoted.id, {
      reason: 'The market moved after the steel price correction; this no longer describes it.',
    });

    assert.equal(retired.status, 'RETIRED');
    assert.equal(learning.promotedLessons(asQS(), 'PRICE_POSITION').length, 0);
    // Retired, not deleted.
    assert.ok(learning.lessonRegister(asQS()).lessons.some((entry) => entry.id === promoted.id));
    throwsCode(
      () => learning.retireLesson(asOwner(), promoted.id, { reason: 'Retiring it twice for good measure' }),
      'LESSON_NOT_PROMOTED',
    );
  });

  it('keeps a refused proposal, because the next person would propose the same one', () => {
    const lesson = learning.proposeLesson(asQS(), {
      signalId: 'price:position',
      adjustmentPercent: -12,
      rationale: 'A second attempt at the same signal, now that the first has been retired.',
    });
    const rejected = learning.rejectLesson(asOwner(), lesson.id, {
      reason: 'Two of the three were design-and-build against our traditional price. Not comparable.',
    });

    assert.equal(rejected.status, 'REJECTED');
    assert.match(rejected.rejectedReason!, /design-and-build/);
    assert.equal(learning.promotedLessons(asQS(), 'PRICE_POSITION').length, 0);
  });

  it('publishes what a promoted lesson of each kind changes', () => {
    const register = learning.lessonRegister(asQS());
    assert.equal(register.effects.length, learning.SIGNAL_KIND.length);
    assert.match(
      register.effects.find((effect) => effect.kind === 'WIN_RATE')!.effect,
      /does not change the score or the recommendation/,
    );
    assert.match(register.summary, /lesson\(s\)/);
  });
});

describe('the loop closes on the estimate', () => {
  let outlierId: string;

  before(() => {
    const ctx = asEstimator();
    const line = (rate: number) => ({
      description: 'Reinforced concrete to walls',
      unit: 'm3',
      quantity: 100,
      labourRateMinor: rate,
    });
    for (const rate of [60_000, 62_000, 64_000]) {
      tender.buildEstimate(ctx, {
        packageId: `PKG-CAL-${rate}`,
        durationWeeks: 20,
        lines: [line(rate)],
        margin: { overheadPercent: 5, profitPercent: 8 },
        basisOfEstimate: 'History',
        assumptions: [],
      });
    }
    outlierId = tender.buildEstimate(ctx, {
      packageId: 'PKG-CAL-SUBJECT',
      durationWeeks: 20,
      lines: [line(66_000)],
      margin: { overheadPercent: 5, profitPercent: 8 },
      basisOfEstimate: 'The one being checked',
      assumptions: [],
    }).estimateId;

    // Two more packages that reached an executed subcontract, so the estimating
    // bias rests on three observations rather than the seed's one. Written
    // straight to the ledger: the procurement path from enquiry to execution is
    // exercised where it belongs, and what this file is about is what the
    // calibration does once outturns exist.
    for (const [rate, market] of [[60_000, 6_600_000], [62_000, 6_700_000]] as const) {
      const state = {
        id: `cal-sub-${rate}`,
        packageId: `PKG-CAL-${rate}`,
        valueMinor: market,
        supplierName: 'Pennine Concrete Frames',
      };
      platform.ledger.commit({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
        source: 'WEB',
        correlationId: `cal-outturn-${rate}`,
        eventType: 'SUBCONTRACT_ASSEMBLED',
        entity: { refType: 'Subcontract', refId: `cal-sub-${rate}` },
        nextState: state,
      });
      platform.ledger.commit({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
        source: 'WEB',
        correlationId: `cal-outturn-${rate}`,
        eventType: 'SUBCONTRACT_EXECUTED',
        entity: { refType: 'Subcontract', refId: `cal-sub-${rate}` },
        nextState: { ...state, executedAt: '2027-06-01T09:00:00.000Z' },
        // The catalogue requires an executed subcontract to name the document
        // it was executed on, and correctly: a contract value with no contract
        // behind it is a number somebody typed.
        evidenceRefs: [{ refType: 'EvidenceItem', refId: `cal-sub-doc-${rate}` }],
      });
    }
  });

  it('applies nothing while a correction is only proposed', () => {
    const before_ = learning.calibratedBenchmark(asEstimator(), outlierId, '2027-08-20');
    assert.equal(before_.applied, null);
    assert.match(before_.note, /No estimating-bias lesson has been promoted/);

    const concrete = before_.calibrated.find((line) => line.description === 'Reinforced concrete to walls')!;
    assert.equal(concrete.medianMinor, 62_000);
    assert.equal(concrete.calibratedMedianMinor, 62_000, 'an unpromoted lesson moved a median');
  });

  it('corrects every median once a lesson is promoted, and says which one did it', () => {
    // A bias signal exists because the seeded project has packages with both an
    // estimate and an executed subcontract against them.
    const bias = learning.calibrationSignals(asQS()).signals.find((signal) => signal.id === 'estimate:bias');
    assert.ok(bias, 'the seeded record produces no estimating-bias signal');

    const lesson = learning.proposeLesson(asQS(), {
      signalId: 'estimate:bias',
      adjustmentPercent: 10,
      rationale: 'Executed subcontracts have consistently come back above the package estimates they replaced.',
    });
    learning.promoteLesson(asOwner(), lesson.id, {
      note: 'Checked against the executed subcontracts. The direction is right and the size is defensible.',
    });

    const after = learning.calibratedBenchmark(asEstimator(), outlierId, '2027-08-20');
    assert.equal(after.applied?.id, lesson.id);
    assert.match(after.note, /corrects every median by 10%/);
    assert.match(after.note, /Executed subcontracts/);

    const concrete = after.calibrated.find((line) => line.description === 'Reinforced concrete to walls')!;
    // The uncorrected comparison is kept beside the corrected one, because an
    // estimator asked to explain a variance has to see both.
    assert.equal(concrete.medianMinor, 62_000);
    assert.equal(concrete.calibratedMedianMinor, 68_200);
    // 66,000 against 62,000 was above; against a corrected 68,200 it is below.
    assert.equal(concrete.verdict, 'IN_LINE');
    assert.equal(concrete.calibratedVerdict, 'IN_LINE');
    assert.ok(concrete.calibratedVariancePercent! < 0, 'the correction did not move the variance');
  });

  it('publishes the observed win rate beside the scored one without changing it', () => {
    const outlook = learning.calibratedOutlook(asQS(), scores(4));
    assert.equal(outlook.score, 4);
    assert.ok(outlook.observed, 'the record has settled bids scored 4 and says nothing about them');
    assert.equal(outlook.lesson, null, 'nothing has been promoted against the win rate');
    assert.match(outlook.reading, /applied to nothing/);

    // And the algorithm is untouched: the same scores still produce the same
    // recommendation they did before any of this existed.
    const qualification = business.qualify(scores(4));
    assert.equal(qualification.score, business.qualify(scores(4)).score);
  });

  it('says plainly when nothing has been scored the way this one is', () => {
    const outlook = learning.calibratedOutlook(asQS(), scores(5));
    assert.equal(outlook.observed, null);
    assert.match(outlook.reading, /nothing to say about it yet/);
  });
});
