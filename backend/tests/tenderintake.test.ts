import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as business from '../src/domain/business.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Tender intake — T-WF-01.
 *
 * Three things go wrong the hour an invitation lands, and every one of them
 * costs the whole bid rather than a percentage of it. These tests try to make
 * each of them happen.
 *
 *   - **The deadline is a wall-clock reading, not an instant.** Noon in Dublin
 *     is an hour before noon in London, and an ITT that does not say whose noon
 *     it means has not stated a deadline at all.
 *   - **The invitation is immutable.** An addendum appends. What the deadline
 *     was on the day the bid was planned has to stay answerable, because a late
 *     submission turns that question into a dispute.
 *   - **A mandatory deliverable with no owner is how a correctly priced bid is
 *     disqualified.** Not lost on price — disqualified, because one certificate
 *     was missing from the upload.
 */

let platform: Platform;
let seed: SeedResult;

const pipelineCtx = (who: string) => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/**
 * Two people, and the permission matrix is why.
 *
 * Recording an invitation, reading it into deliverables and back-planning the
 * tender programme are estimating acts and sit with the QS. Deciding whether
 * the business chases the job at all is a governance act and sits with the
 * Owner. Writing these tests as one actor failed on the matrix, which is the
 * matrix doing its job — so they are written as the two people who really do
 * this work.
 */
const asQS = () => pipelineCtx('qs');
const asOwner = () => pipelineCtx('owner');

const flat = (value: number): business.QualificationScores =>
  Object.fromEntries(business.QUALIFICATION_CRITERIA.map((c) => [c.key, value])) as business.QualificationScores;

let counter = 0;

/** A qualified opportunity to hang an invitation on. */
function opportunity(ctx: ReturnType<typeof pipelineCtx>, scores = flat(4)): string {
  counter += 1;
  const { opportunityId } = business.registerOpportunity(ctx, {
    title: `Tender intake fixture ${counter}`,
    clientName: 'Northgate Estates',
    sectorType: 'COMMERCIAL',
    estimatedValueMinor: 6_000_000_00,
    source: 'Tender portal',
  });
  business.qualifyOpportunity(ctx, opportunityId, scores);
  return opportunityId;
}

const INVITATION = {
  reference: 'ITT/2027/014',
  issuedAt: '2027-01-11T09:00:00.000Z',
  returnLocal: '2027-03-12T12:00',
  timeZone: 'Europe/London',
  timeZoneStated: true,
  channel: 'PORTAL' as const,
};

/** A complete mandatory deliverable: source, owner and internal date all present. */
const complete = (reference: string, title: string): tenderintake.TenderDeliverable => ({
  reference,
  title,
  mandatory: true,
  owner: 'QS',
  internalDueBy: '2027-03-09',
  source: { document: 'Instructions to Tenderers', clause: '4.2', page: 11 },
});

function record(ctx: ReturnType<typeof pipelineCtx>, opportunityId: string, overrides: Partial<typeof INVITATION> = {}) {
  return tenderintake.recordInvitation(ctx, opportunityId, { ...INVITATION, ...overrides });
}

function extract(
  ctx: ReturnType<typeof pipelineCtx>,
  invitationId: string,
  deliverables: tenderintake.TenderDeliverable[],
) {
  // The compliance matrix belongs to `analyseITT`; the intake binds to it by
  // id. The tests bind to a stand-in id where the matrix itself is not the
  // subject, so that a failure here is never a failure in the analyser.
  return tenderintake.extractRequirements(ctx, invitationId, { deliverables, analysisId: `analysis-${invitationId}` });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The deadline ────────────────────────────────────────────────────────────

describe('tender intake · the deadline is an instant, not a reading', () => {
  it('resolves a stated local time in a named zone to one instant', () => {
    // British Summer Time: noon in London on 12 June is 11:00 UTC.
    const summer = tenderintake.resolveZonedInstant('2027-06-12T12:00', 'Europe/London');
    assert.equal(summer.instant, '2027-06-12T11:00:00.000Z');
    assert.equal(summer.offsetMinutes, 60);
    assert.equal(summer.anomaly, undefined);

    // Greenwich Mean Time: noon in London on 12 January is 12:00 UTC.
    const winter = tenderintake.resolveZonedInstant('2027-01-12T12:00', 'Europe/London');
    assert.equal(winter.instant, '2027-01-12T12:00:00.000Z');
    assert.equal(winter.offsetMinutes, 0);
  });

  /**
   * The failure this whole mechanism exists for. A portal that closes at noon
   * in Dublin has closed an hour before noon in Berlin, and a bid team working
   * to the wrong one submits sixty minutes after the door shut.
   */
  it('reads the same stated noon as different instants in different zones', () => {
    const london = tenderintake.resolveZonedInstant('2027-06-12T12:00', 'Europe/London');
    const berlin = tenderintake.resolveZonedInstant('2027-06-12T12:00', 'Europe/Berlin');
    const auckland = tenderintake.resolveZonedInstant('2027-06-12T12:00', 'Pacific/Auckland');

    assert.notEqual(london.instant, berlin.instant);
    assert.equal(Date.parse(london.instant) - Date.parse(berlin.instant), 60 * 60 * 1000);
    // The far side of the world is a different day, not a different hour.
    assert.ok(Date.parse(auckland.instant) < Date.parse(london.instant));
  });

  it('refuses a zone it does not recognise rather than guessing one', () => {
    throwsCode(() => tenderintake.resolveZonedInstant('2027-06-12T12:00', 'Europe/Camelot'), 'TIME_ZONE_UNKNOWN');
    throwsCode(() => tenderintake.resolveZonedInstant('2027-06-12T12:00', 'GMT+1'), 'TIME_ZONE_UNKNOWN');
  });

  it('refuses a reading it cannot parse', () => {
    throwsCode(() => tenderintake.resolveZonedInstant('noon on the twelfth', 'Europe/London'), 'DEADLINE_UNREADABLE');
  });

  /**
   * On the night the clocks go back, 01:30 in London happens twice. A deadline
   * expressed that way is genuinely two instants, and the platform takes the
   * earlier of them: resolved early is submitted early, and the other way round
   * is submitted late.
   */
  it('names an ambiguous reading and takes the earlier instant', () => {
    const ambiguous = tenderintake.resolveZonedInstant('2027-10-31T01:30', 'Europe/London');
    assert.equal(ambiguous.anomaly, 'AMBIGUOUS');
    // BST is still in force at the earlier of the two, so the offset is +60.
    assert.equal(ambiguous.offsetMinutes, 60);
    assert.equal(ambiguous.instant, '2027-10-31T00:30:00.000Z');
  });

  /** On the night they go forward, 01:30 never happens at all. */
  it('names a reading that does not occur', () => {
    const skipped = tenderintake.resolveZonedInstant('2027-03-28T01:30', 'Europe/London');
    assert.equal(skipped.anomaly, 'SKIPPED');
  });
});

// ── Recording the invitation ────────────────────────────────────────────────

describe('tender intake · recording the invitation', () => {
  it('registers the deadline before anybody has read the documents', () => {
    const ctx = pipelineCtx('qs');
    const opportunityId = opportunity(ctx);
    const { invitationId, deadline, clarifications } = record(ctx, opportunityId);

    assert.ok(invitationId);
    assert.equal(deadline.instant, '2027-03-12T12:00:00.000Z');
    assert.deepEqual(clarifications, []);

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.equal(position.requirementsExtracted, false, 'nothing has been read yet');
    assert.equal(position.deliverables.total, 0);
    // And the countdown is already running.
    assert.ok(position.businessDaysRemaining > 30, 'the deadline is live from the moment it is recorded');
  });

  /**
   * `AC-T-WF-01-01`'s reason for existing, seen from the other end: an
   * invitation whose zone was never stated is a Critical clarification, not a
   * default. The platform records the assumption it made and says so.
   */
  it('raises a critical clarification where the invitation did not state a zone', () => {
    const ctx = pipelineCtx('qs');
    const { clarifications } = record(ctx, opportunity(ctx), { timeZoneStated: false });

    const critical = clarifications.filter((c) => c.severity === 'CRITICAL');
    assert.equal(critical.length, 1);
    assert.match(critical[0]!.subject, /time zone/i);
    // The question is written in the words it would be put to the buyer in,
    // and it names the assumption that was made.
    assert.match(critical[0]!.question, /Europe\/London/);
  });

  it('raises a critical clarification where the question deadline is not before the return', () => {
    const ctx = pipelineCtx('qs');
    const { clarifications } = record(ctx, opportunity(ctx), { clarificationLocal: '2027-03-12T12:00' } as never);

    assert.ok(
      clarifications.some((c) => c.severity === 'CRITICAL' && /question/i.test(c.subject)),
      'a question deadline at the return date was not raised',
    );
  });

  it('flags a site visit falling after the return as a major clarification', () => {
    const ctx = pipelineCtx('qs');
    const { clarifications } = record(ctx, opportunity(ctx), { siteVisitLocal: '2027-03-15T10:00' } as never);

    const visit = clarifications.find((c) => /site visit/i.test(c.subject));
    assert.equal(visit?.severity, 'MAJOR');
    assert.match(visit!.question, /carries whatever the visit would have found/);
  });

  it('refuses a deadline at or before the moment of issue', () => {
    const ctx = pipelineCtx('qs');
    throwsCode(() => record(ctx, opportunity(ctx), { returnLocal: '2027-01-11T09:00' }), 'DEADLINE_BEFORE_ISSUE');
  });

  it('refuses a second invitation on the same opportunity', () => {
    const ctx = pipelineCtx('qs');
    const opportunityId = opportunity(ctx);
    record(ctx, opportunityId);
    // An invitation is amended by addendum, never re-recorded — otherwise the
    // original issue is silently replaced and the history is gone.
    throwsCode(() => record(ctx, opportunityId, { reference: 'ITT/2027/014-R2' }), 'TENDER_ALREADY_RECORDED');
  });

  it('refuses to record an invitation against an opportunity that does not exist', () => {
    const ctx = pipelineCtx('qs');
    throwsCode(() => record(ctx, 'not-an-opportunity'), 'OPPORTUNITY_NOT_FOUND');
  });
});

// ── Deliverables ────────────────────────────────────────────────────────────

describe('tender intake · the deliverable register', () => {
  it('records what has to be returned, with source, owner and internal date', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));

    const result = extract(ctx, invitationId, [
      complete('D-01', 'Priced pricing schedule'),
      { ...complete('D-02', 'Method statement'), owner: 'EPC', pageLimit: 20 },
      { reference: 'D-03', title: 'Optional social value case study', mandatory: false },
    ]);

    assert.equal(result.deliverables, 3);
    assert.deepEqual(result.blockers, [], 'nothing mandatory is missing anything');

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.equal(position.requirementsExtracted, true);
    assert.deepEqual(position.deliverables, { total: 3, mandatory: 2 });
  });

  it('refuses an invitation recorded as asking for nothing back', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    throwsCode(() => extract(ctx, invitationId, []), 'DELIVERABLES_EMPTY');
  });

  it('refuses the same deliverable reference twice', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    throwsCode(
      () => extract(ctx, invitationId, [complete('D-01', 'Pricing schedule'), complete('D-01', 'Also the pricing schedule')]),
      'DELIVERABLE_DUPLICATE',
    );
  });

  it('raises a critical clarification for an internal date after the return', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [{ ...complete('D-01', 'Bond'), internalDueBy: '2027-04-01' }]);

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.ok(
      position.clarifications.some((c) => c.severity === 'CRITICAL' && /due after the return/.test(c.subject)),
      'an internal date past the return deadline was not raised',
    );
  });

  /**
   * `AC-T-WF-01-01`. Source, owner and internal date, on every mandatory
   * deliverable — and on none of the optional ones, because blocking on those
   * would teach everybody to mark things optional.
   */
  it('names exactly what a mandatory deliverable is missing', () => {
    const blockers = tenderintake.deliverableBlockers([
      { reference: 'D-01', title: 'Parent company guarantee', mandatory: true },
      { reference: 'D-02', title: 'Pricing schedule', mandatory: true, owner: 'QS', source: { document: 'ITT' } },
      { reference: 'D-03', title: 'Nice-to-have case study', mandatory: false },
    ]);

    assert.equal(blockers.length, 2, 'the optional deliverable was blocked, or a mandatory one was missed');
    // The sentence has to read out loud: it is put in front of somebody the day
    // before a return, and a mangled one gets a real warning ignored.
    assert.match(blockers[0]!, /is missing an owner, a source in the invitation and an internal date$/);
    assert.match(blockers[1]!, /D-02/);
    assert.match(blockers[1]!, /is missing an internal date$/);
  });
});

// ── The bid approval gate ───────────────────────────────────────────────────
describe('tender intake · the gate in front of a decision to bid', () => {
  it('refuses to record a bid while a mandatory deliverable has no owner', () => {
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId);
    extract(asQS(), invitationId, [{ reference: 'D-01', title: 'Employer’s liability certificate', mandatory: true }]);

    throwsCode(
      () => business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Good client, right size' }),
      'TENDER_DELIVERABLES_INCOMPLETE',
    );
  });

  it('refuses to record a bid on an invitation nobody has read', () => {
    const opportunityId = opportunity(asOwner());
    record(asQS(), opportunityId);

    const error = throwsCode(
      () => business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Looks straightforward' }),
      'TENDER_DELIVERABLES_INCOMPLETE',
    );
    assert.match(String(error.message), /has not been read/);
  });

  /**
   * Declining is never gated. Refusing bad work is the behaviour the whole
   * qualification algorithm exists to encourage, and making a refusal the
   * expensive option would defeat it.
   */
  it('lets a no-bid be recorded on an invitation nobody has read', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    record(asQS(), opportunityId);

    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: false,
      rationale: 'No capacity in the window, and the deliverables are not scoped',
    });
    assert.equal(decision.stage, 'NO_BID');
  });

  it('allows the bid once every mandatory deliverable is complete', () => {
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId);
    extract(asQS(), invitationId, [complete('D-01', 'Pricing schedule'), complete('D-02', 'Programme')]);

    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Repeat client, inside our patch, supply chain covered',
      conditions: ['Subject to the buyer capping liquidated damages at 5%'],
    });

    assert.equal(decision.stage, 'BID');
    assert.deepEqual(decision.conditions, ['Subject to the buyer capping liquidated damages at 5%']);
  });

  /** An opportunity with no formal invitation has no gate to pass. */
  it('leaves opportunities with no invitation exactly as they were', () => {
    const opportunityId = opportunity(asOwner());
    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Relationship bid, no formal ITT',
    });
    assert.equal(decision.stage, 'BID');
  });
});

// ── Authority ───────────────────────────────────────────────────────────────

describe('tender intake · the authority an override is taken under', () => {
  /**
   * `AC-T-WF-01-02`. Overriding a published rule is an exercise of authority.
   * An override with nobody's authority named on it is the finding a
   * post-mortem cannot answer, which is exactly the finding it goes looking for.
   */
  it('refuses an override with no authority named', () => {
    const opportunityId = opportunity(asOwner(), flat(2)); // recommends NO_BID

    const error = throwsCode(
      () => business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Strategic entry into a new client' }),
      'AUTHORITY_REQUIRED',
    );
    // The refusal states the score it is being overridden at, so the person
    // reading it knows what they are about to sign against.
    assert.match(String(error.message), /recommends no bid at a score of/);
  });

  it('records the authority, the conditions and the dissent on an override', () => {
    const opportunityId = opportunity(asOwner(), flat(2));

    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Strategic entry into a client we have wanted for three years',
      conditions: ['Bid only if the programme is extended by two weeks'],
      dissent: [{ by: 'Commercial Director', position: 'The margin does not cover the bid cost at this score' }],
      authority: {
        delegatedTo: 'Chief Executive',
        reference: 'Scheme of delegation, board minute 2027/03',
        limitMinor: 10_000_000_00,
      },
    });

    assert.equal(decision.againstRecommendation, true);

    const stored = platform.ledger.get({ refType: 'Opportunity', refId: opportunityId })!;
    const recorded = stored.state.decision as {
      authority?: { delegatedTo: string };
      dissent: Array<{ by: string }>;
      conditions: string[];
      score: number;
      recommendation: string;
    };
    assert.equal(recorded.authority?.delegatedTo, 'Chief Executive');
    assert.equal(recorded.dissent[0]?.by, 'Commercial Director');
    assert.equal(recorded.conditions.length, 1);
    // The scoring is on the record beside the override, which is what makes
    // the divergence legible without going and looking it up.
    assert.equal(recorded.recommendation, 'NO_BID');
    assert.ok(recorded.score > 0);
  });

  it('needs no authority where the decision follows the recommendation', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: false,
      rationale: 'Scores badly on every factor',
    });
    assert.equal(decision.againstRecommendation, false);
  });
});

// ── Addenda ─────────────────────────────────────────────────────────────────

describe('tender intake · an addendum appends and never rewrites', () => {
  it('moves the deadline in force while leaving the original issue readable', () => {
    const { invitationId } = record(asQS(), opportunity(asOwner()));

    const result = tenderintake.issueAddendum(asQS(), invitationId, {
      reference: 'ADD-01',
      issuedAt: '2027-02-01T10:00:00.000Z',
      summary: 'Return date extended by one week following the site visit',
      returnLocal: '2027-03-19T12:00',
    });

    assert.equal(result.deadline.instant, '2027-03-19T12:00:00.000Z');
    assert.equal(result.reReviewRequired, true);
    assert.match(result.addendum.reReviewReasons[0]!, /moved back/);

    // The original is still exactly what it was.
    const stored = platform.ledger.get({ refType: 'TenderInvitation', refId: invitationId })!;
    const issue = stored.state.issue as { returnDeadline: { instant: string } };
    assert.equal(issue.returnDeadline.instant, '2027-03-12T12:00:00.000Z', 'the addendum overwrote the issue');
  });

  it('takes the last addendum that moved the date, not the last addendum', () => {
    const { invitationId } = record(asQS(), opportunity(asOwner()));

    tenderintake.issueAddendum(asQS(), invitationId, {
      reference: 'ADD-01',
      issuedAt: '2027-02-01T10:00:00.000Z',
      summary: 'Return date extended',
      returnLocal: '2027-03-19T12:00',
    });
    // An addendum that changes something else must not silently revert the date.
    tenderintake.issueAddendum(asQS(), invitationId, {
      reference: 'ADD-02',
      issuedAt: '2027-02-08T10:00:00.000Z',
      summary: 'Revised drawing pack issued; no change to the return date',
    });

    const position = tenderintake.tenderPosition(asQS(), invitationId, { today: '2027-02-08' });
    assert.equal(position.deadline.instant, '2027-03-19T12:00:00.000Z');
    assert.equal(position.addenda, 2);
  });

  it('refuses the same addendum reference twice and refuses one with no summary', () => {
    const { invitationId } = record(asQS(), opportunity(asOwner()));
    const addendum = { reference: 'ADD-01', issuedAt: '2027-02-01T10:00:00.000Z', summary: 'Revised specification' };

    tenderintake.issueAddendum(asQS(), invitationId, addendum);
    throwsCode(() => tenderintake.issueAddendum(asQS(), invitationId, addendum), 'ADDENDUM_DUPLICATE');
    throwsCode(
      () => tenderintake.issueAddendum(asQS(), invitationId, { ...addendum, reference: 'ADD-02', summary: '  ' }),
      'ADDENDUM_SUMMARY_REQUIRED',
    );
  });

  /**
   * The re-review is derived by comparing timestamps rather than held as a flag.
   * A flag can be cleared; a comparison can only be answered by deciding again.
   */
  it('makes a bid decision stale when an addendum lands after it', () => {
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId);
    extract(asQS(), invitationId, [complete('D-01', 'Pricing schedule')]);
    business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Right size, right client' });

    tenderintake.issueAddendum(asQS(), invitationId, {
      reference: 'ADD-01',
      issuedAt: '2027-02-01T10:00:00.000Z',
      summary: 'A performance bond is now required',
      addedDeliverables: [complete('D-09', 'Performance bond, 10%')],
    });

    const position = tenderintake.tenderPosition(asQS(), invitationId, { today: '2027-02-01' });
    assert.equal(position.reReviewReasons.length, 1);
    assert.match(position.reReviewReasons[0]!, /D-09/);

    // And the programme cannot be built on a superseded invitation.
    throwsCode(() => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-02-01' }), 'BID_DECISION_STALE');

    // Deciding again answers it. Nothing was cleared; the decision is simply
    // now later than the addendum.
    business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Bond confirmed available from the broker' });
    assert.deepEqual(tenderintake.tenderPosition(asQS(), invitationId, { today: '2027-02-01' }).reReviewReasons, []);
  });

  it('does not force a re-review for an addendum that changes nothing material', () => {
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId);
    extract(asQS(), invitationId, [complete('D-01', 'Pricing schedule')]);
    business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Right size, right client' });

    const result = tenderintake.issueAddendum(asQS(), invitationId, {
      reference: 'ADD-01',
      issuedAt: '2027-02-01T10:00:00.000Z',
      summary: 'Clarification: the car park is outside the site boundary',
    });

    assert.equal(result.reReviewRequired, false);
    assert.deepEqual(tenderintake.tenderPosition(asQS(), invitationId, { today: '2027-02-01' }).reReviewReasons, []);
  });
});

// ── The bid programme ───────────────────────────────────────────────────────

describe('tender intake · the tender programme, back-planned', () => {
  /** The QS records and reads the invitation; the Owner decides the bid. */
  function bidding(returnLocal: string): string {
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId, { returnLocal });
    extract(asQS(), invitationId, [
      complete('D-01', 'Priced pricing schedule'),
      { ...complete('D-02', 'Construction programme'), owner: 'PLANNER', internalDueBy: '2027-03-05' },
    ]);
    business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Right size, right client, covered supply chain',
    });
    return invitationId;
  }

  it('plans the whole spine inside the window and lands on the submission day', () => {
    const programme = tenderintake.generateBidProgramme(asQS(), bidding('2027-03-12T12:00'), { from: '2027-01-11' });

    assert.equal(programme.milestones.length, tenderintake.BID_SPINE.length);
    // 12 March 2027 is a Friday, so the submission day is the deadline's own day.
    assert.equal(programme.submissionDay, '2027-03-12');
    assert.equal(programme.milestones.at(-1)!.finish, programme.submissionDay, 'the programme did not land on the deadline');
    assert.equal(programme.milestones[0]!.start, '2027-01-11');

    // The stages run consecutively with no gap and no overlap.
    for (let i = 1; i < programme.milestones.length; i++) {
      assert.equal(programme.milestones[i]!.start, programme.milestones[i - 1]!.finish);
    }
    const planned = programme.milestones.reduce((sum, m) => sum + m.businessDays, 0);
    assert.equal(planned, programme.availableBusinessDays);
  });

  /**
   * The same spine has to serve a ten-day quotation and a ninety-day two-stage
   * tender. Fixed offsets would do neither; proportional stages with a floor do
   * both, and the floor is visible on the record when it bites.
   */
  it('scales the stages to the window rather than using fixed offsets', () => {
    const long = tenderintake.generateBidProgramme(asQS(), bidding('2027-06-11T12:00'), { from: '2027-01-11' });
    const short = tenderintake.generateBidProgramme(asQS(), bidding('2027-02-01T12:00'), { from: '2027-01-11' });

    assert.ok(long.availableBusinessDays > short.availableBusinessDays);
    const returns = (p: typeof long) => p.milestones.find((m) => m.key === 'ENQUIRIES_IN')!;
    assert.ok(
      returns(long).businessDays > returns(short).businessDays,
      'a three-times-longer tender gave the supply chain no longer to price it',
    );
    // On the short one the light stages sit at their floor and say so.
    assert.ok(short.milestones.some((m) => m.atMinimum));
  });

  /**
   * Below the floor the platform refuses. Compressing eight stages into four
   * days produces a programme that reads as achievable and is not, which is a
   * worse answer than "this is not enough time".
   */
  it('refuses a window the spine cannot fit in, and shows the arithmetic', () => {
    const invitationId = bidding('2027-01-18T12:00');

    const error = throwsCode(
      () => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11' }),
      'TENDER_WINDOW_TOO_SHORT',
    );
    assert.match(String(error.message), /business days? remain/);
    assert.match(String(error.message), new RegExp(String(tenderintake.BID_SPINE_MINIMUM_DAYS)));
    assert.match(String(error.message), /will not compress it silently/);
  });

  it('builds work packages from the deliverables, each with its earliest date', () => {
    const programme = tenderintake.generateBidProgramme(asQS(), bidding('2027-03-12T12:00'), { from: '2027-01-11' });

    const planner = programme.workPackages.find((p) => p.owner === 'PLANNER');
    const qs = programme.workPackages.find((p) => p.owner === 'QS');
    assert.ok(planner, 'the planner owes nothing, on a tender with a programme deliverable');
    assert.ok(qs);
    assert.equal(planner!.earliestDueBy, '2027-03-05');
    assert.equal(qs!.earliestDueBy, '2027-03-09');
    assert.equal(planner!.mandatoryCount, 1);
  });

  it('puts the return deadline and the fixed dates on the programme', () => {
    const programme = tenderintake.generateBidProgramme(asQS(), bidding('2027-03-12T12:00'), { from: '2027-01-11' });
    assert.ok(programme.fixedDates.some((d) => /Return deadline/.test(d.label) && /Europe\/London/.test(d.date)));
  });

  /** `AC-T-WF-01-03`. A no-bid does not proceed. */
  it('refuses a tender programme for an opportunity decided as a no-bid', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    const { invitationId } = record(asQS(), opportunityId);
    business.decideBidNoBid(asOwner(), opportunityId, { bid: false, rationale: 'Outside our operating patch' });

    const error = throwsCode(
      () => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11' }),
      'OPPORTUNITY_NOT_BID',
    );
    assert.match(String(error.message), /cannot proceed to pricing/);
  });

  it('refuses a tender programme before any decision has been taken', () => {
    const { invitationId } = record(asQS(), opportunity(asOwner()));
    throwsCode(() => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11' }), 'OPPORTUNITY_NOT_BID');
  });
});

// ── AC-T-WF-01-03 ───────────────────────────────────────────────────────────

describe('tender intake · a no-bid stays searchable and stays out of pricing', () => {
  it('keeps the rationale and leaves the opportunity in the pipeline', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    record(asQS(), opportunityId);
    business.decideBidNoBid(asOwner(), opportunityId, {
      bid: false,
      rationale: 'Two hundred miles outside the patch and nobody on the register for the cladding',
    });

    const found = business.pipeline(asOwner()).opportunities.find((o) => o.id === opportunityId);
    assert.ok(found, 'the no-bid disappeared from the pipeline');
    assert.equal(found!.stage, 'NO_BID');

    const stored = platform.ledger.get({ refType: 'Opportunity', refId: opportunityId })!;
    const decision = stored.state.decision as { rationale: string };
    assert.match(decision.rationale, /cladding/, 'the rationale was not preserved');
  });

  it('refuses to convert a no-bid into a project', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    business.decideBidNoBid(asOwner(), opportunityId, { bid: false, rationale: 'No capacity' });

    throwsCode(
      () =>
        business.convertToProject(asOwner(), opportunityId, {
          projectName: 'Should not exist',
          // Never read: the stage is checked before anything is created, which
          // is the point — a no-bid is refused before it can touch a portfolio.
          portfolioId: 'not-reached',
          assetType: 'Office',
          location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
          currency: 'GBP',
          plannedStart: '2027-04-01',
          plannedCompletion: '2028-04-01',
        }),
      'OPPORTUNITY_NOT_WON',
    );
  });
});

// ── The board, and the catalogue ────────────────────────────────────────────

describe('tender intake · the board and the event catalogue', () => {
  it('orders the board by deadline and counts what is outstanding', () => {
    const board = tenderintake.tenderBoard(asQS(), { today: '2027-01-11' });

    assert.ok(board.tenders.length > 0);
    for (let i = 1; i < board.tenders.length; i++) {
      assert.ok(
        board.tenders[i - 1]!.deadline.instant <= board.tenders[i]!.deadline.instant,
        'the board is not in deadline order',
      );
    }
    assert.match(board.summary, /invitations? recorded/);
  });

  /**
   * The specification names four events. Two of them are acts that did not
   * exist and take the specification's own names; two are acts that did, under
   * names already written to an append-only ledger. Renaming those would orphan
   * every record already carrying the old name, so they are mapped instead —
   * and this test is where the mapping is written down.
   */
  it('registers the new events and leaves the existing two alone', () => {
    for (const code of ['TENDER_RECEIVED', 'TENDER_REQUIREMENTS_EXTRACTED', 'TENDER_ADDENDUM_ISSUED', 'TENDER_PROGRAMME_CREATED']) {
      assert.ok(lookupEventType(code), `${code} is not in the catalogue`);
    }

    // COMPLIANCE_MATRIX_CREATED is ITT_ANALYSED; BID_DECISION_RECORDED is
    // BID_NO_BID_DECIDED. Both already existed and neither was renamed.
    assert.ok(lookupEventType('ITT_ANALYSED'));
    assert.ok(lookupEventType('BID_NO_BID_DECIDED'));
    assert.equal(lookupEventType('COMPLIANCE_MATRIX_CREATED'), undefined);
    assert.equal(lookupEventType('BID_DECISION_RECORDED'), undefined);

    // Extraction is the one act the specification gives an agent. Recording the
    // deadline and deciding the bid are not.
    assert.equal(lookupEventType('TENDER_REQUIREMENTS_EXTRACTED')!.aiAllowed, true);
    assert.equal(lookupEventType('TENDER_RECEIVED')!.aiAllowed, false);
    assert.equal(lookupEventType('BID_NO_BID_DECIDED')!.aiAllowed, false);
  });
});
