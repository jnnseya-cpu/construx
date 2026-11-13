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

  it('preserves the bidder’s assignments across a re-read instead of wiping them', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    // Read once: a mandatory return with nothing assigned yet (owner, internal
    // date and source are the bidder's, never in the buyer's document).
    extract(ctx, invitationId, [{ reference: 'D-01', title: 'Pricing schedule', mandatory: true }]);
    // The bidder owns it.
    tenderintake.assignDeliverable(ctx, invitationId, {
      reference: 'D-01',
      owner: 'QS',
      internalDueBy: '2027-03-09',
      source: { document: 'Instructions to Tenderers', clause: '4.2' },
    });
    // Read again — a refresh of the buyer's side, same reference, no assignment.
    extract(ctx, invitationId, [{ reference: 'D-01', title: 'Pricing schedule (rev B)', mandatory: true }]);

    const back = tenderintake
      .tenderPosition(ctx, invitationId, { today: '2027-01-11' })
      .returns.find((d) => d.reference === 'D-01')!;
    assert.equal(back.owner, 'QS', 'the owner survived the re-read');
    assert.equal(back.internalDueBy, '2027-03-09', 'our internal date survived the re-read');
    assert.ok(back.source?.document, 'the source survived the re-read');
    assert.equal(back.title, 'Pricing schedule (rev B)', 'the buyer-side title still refreshed');
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

// ── Assigning a return already on the invitation ────────────────────────────

/**
 * The gate that had no door, which is worse than no gate.
 *
 * Reading an invitation is the route the platform recommends and the only
 * practical one on a tender with forty returns. It files what the buyer asked
 * for, and it cannot file an owner or an internal date, because neither is in
 * the buyer's document — they are this business committing its own people. And
 * `addDeliverable` refuses a reference that is already there, correctly: two
 * rows for `D-01` is how one of them goes unanswered.
 *
 * So the decision to bid refused with blockers nothing in the platform could
 * clear, and it refused them to somebody with a return date coming. These tests
 * are the whole round trip: read, blocked, assign, decided.
 */
describe('tender intake · giving a read return its owner and our date', () => {
  it('clears the bid gate a reading could not clear itself', () => {
    const ctx = pipelineCtx('qs');
    const opportunityId = opportunity(ctx);
    const { invitationId } = record(ctx, opportunityId);

    // A reading, as the analyser files one: the buyer's own facts and a source,
    // and nothing about who here owns it.
    const read = extract(ctx, invitationId, [
      { reference: 'APP5', title: 'EPC cost model, fully priced', mandatory: true, format: 'XLSX', source: { document: 'ITT', clause: '4.1' } },
      { reference: 'APP2', title: 'Order form, signed', mandatory: true, signatureRequired: true, source: { document: 'ITT', clause: '4.2' } },
    ]);
    assert.equal(read.blockers.length, 2, 'a reading filed returns that were somehow already complete');

    // The decision to bid is a commercial go/no-go, taken from the score and
    // what the tender asks for. A read invitation with returns still to assign
    // does not block it: the commitment is recorded and the returns it still
    // owes are carried on the decision, so who produces each one is planned
    // after the business has said it is bidding — not before.
    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Four years of the same work for the same client, and the rates hold.',
    });
    assert.equal(decision.stage, 'BID');
    assert.equal(decision.outstandingReturns.length, 2, 'the decision did not carry the returns still to assign');

    // The door. One assignment per return, and the blockers fall as they go —
    // this is the planning that follows the commitment, and it is what the
    // submission gate will check before anything goes out.
    const first = tenderintake.assignDeliverable(ctx, invitationId, { reference: 'APP5', owner: 'QS', internalDueBy: '2027-03-09' });
    assert.equal(first.blockers.length, 1, 'assigning one return cleared the wrong number of blockers');
    assert.equal(first.assigned.owner, 'QS');
    // What the buyer asked for is untouched. An assignment is not a correction.
    assert.equal(first.assigned.format, 'XLSX');
    assert.equal(first.assigned.mandatory, true);
    assert.equal(first.assigned.source?.clause, '4.1');

    const second = tenderintake.assignDeliverable(ctx, invitationId, { reference: 'APP2', owner: 'PM', internalDueBy: '2027-03-05' });
    assert.deepEqual(second.blockers, [], 'the register is complete and the gate still reports a blocker');

    // Both returns are on the register once, with everything the gate asks for.
    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.deepEqual(position.deliverables, { total: 2, mandatory: 2 });
    assert.deepEqual(position.returns.map((d) => d.reference).sort(), ['APP2', 'APP5']);
    assert.equal(position.returns.find((d) => d.reference === 'APP5')!.internalDueBy, '2027-03-09');
  });

  it('publishes the register itself, not a count of it', () => {
    // The count was all the console could see, so the one list a bid manager
    // works from was unreadable in the product — and the gate would name a
    // reference no screen could explain.
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [complete('D-01', 'Priced pricing schedule')]);

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.equal(position.returns.length, 1);
    assert.equal(position.returns[0]!.title, 'Priced pricing schedule');
    assert.equal(position.returns[0]!.owner, 'QS');
  });

  it('refuses a reference the invitation does not hold, and says which it does', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [complete('D-01', 'Pricing schedule')]);

    throwsCode(() => tenderintake.assignDeliverable(ctx, invitationId, { reference: 'APP9', owner: 'QS' }), 'DELIVERABLE_NOT_FOUND');
    // The remedy is in the message, because a reference typed from a blocker
    // sentence is exactly where this goes wrong.
    assert.throws(
      () => tenderintake.assignDeliverable(ctx, invitationId, { reference: 'APP9', owner: 'QS' }),
      /It holds D-01/,
    );
  });

  it('refuses an assignment that would change nothing', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [complete('D-01', 'Pricing schedule')]);
    throwsCode(() => tenderintake.assignDeliverable(ctx, invitationId, { reference: 'D-01' }), 'DELIVERABLE_ASSIGNMENT_EMPTY');
  });

  it('raises a critical clarification for an internal date behind the return', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [{ reference: 'D-01', title: 'Bond', mandatory: true, source: { document: 'ITT' } }]);

    tenderintake.assignDeliverable(ctx, invitationId, { reference: 'D-01', owner: 'QS', internalDueBy: '2027-04-01' });
    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2027-01-11' });
    assert.ok(
      position.clarifications.some((c) => c.severity === 'CRITICAL' && /D-01 is due after the return/.test(c.subject)),
      'an internal date past the return was accepted in silence',
    );
  });

  /**
   * Who owns a return and by when is this company committing its people. The
   * reading above it is an agent's act and says so; this one is not, and the
   * catalogue is where that is enforced rather than in a comment.
   */
  it('is a human act on the thread, with no AI mandate', () => {
    const assigned = lookupEventType('TENDER_DELIVERABLE_ASSIGNED');
    assert.equal(assigned?.entity, 'TenderInvitation');
    assert.equal(assigned?.aiAllowed, false);
    assert.equal(lookupEventType('TENDER_REQUIREMENTS_EXTRACTED')?.aiAllowed, true);
  });

  it('is refused to a role that does not hold estimating', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [complete('D-01', 'Pricing schedule')]);
    // The safety lead reads the pipeline and writes none of it.
    throwsCode(
      () => tenderintake.assignDeliverable(pipelineCtx('safety'), invitationId, { reference: 'D-01', owner: 'QS' }),
      'ACCESS_DENIED',
    );
  });
});

// ── The bid approval gate ───────────────────────────────────────────────────
describe('tender intake · the gate in front of a decision to bid', () => {
  it('records a bid with returns still to assign, and carries them as outstanding', () => {
    // The decision is a commercial go/no-go, not a production sign-off. A read
    // invitation whose returns have no owner yet does not block it: assigning
    // who produces each return is the planning that follows the commitment, and
    // the submission gate — not this one — is what refuses an incomplete pack.
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId);
    extract(asQS(), invitationId, [{ reference: 'D-01', title: 'Employer’s liability certificate', mandatory: true }]);

    const decision = business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Good client, right size' });
    assert.equal(decision.stage, 'BID');
    assert.ok(decision.outstandingReturns.length > 0, 'the unassigned return was not carried onto the decision');
  });

  it('refuses to record a bid on an invitation nobody has read', () => {
    const opportunityId = opportunity(asOwner());
    record(asQS(), opportunityId);

    const error = throwsCode(
      () => business.decideBidNoBid(asOwner(), opportunityId, { bid: true, rationale: 'Looks straightforward' }),
      'TENDER_NOT_READ',
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

// ── The conditional bid — the third decision ─────────────────────────────────
describe('tender intake · a conditional bid', () => {
  const commitment = {
    condition: 'Can an approved HV switching contractor meet the outage dates?',
    owner: 'Commercial manager',
    spendCapMinor: 200_000,
    killDate: '2027-01-15',
  };

  it('records limited work to a condition, with owner, cap and kill date, before the invitation is read', () => {
    // The point of a conditional bid is to authorise the work that resolves an
    // open question, so it is not held behind the invitation being fully read.
    const opportunityId = opportunity(asOwner());
    const { invitationId } = record(asQS(), opportunityId); // recorded, deliberately not read

    const decision = business.decideBidNoBid(asOwner(), opportunityId, {
      bid: true,
      rationale: 'Worth pursuing if the switching contractor can hold the dates',
      conditional: commitment,
    });

    assert.equal(decision.stage, 'BID');
    assert.equal(decision.conditional, true);

    const state = platform.ledger.require({ refType: 'TenderInvitation', refId: invitationId }).state;
    assert.ok(state, 'the invitation is still on file');
    const dec = platform.ledger.require({ refType: 'Opportunity', refId: opportunityId }).state.decision as {
      conditional?: boolean;
      conditionalCommitment?: { condition: string; owner: string; spendCapMinor: number; killDate: string };
    };
    assert.equal(dec.conditional, true);
    assert.equal(dec.conditionalCommitment?.owner, 'Commercial manager');
    assert.equal(dec.conditionalCommitment?.spendCapMinor, 200_000);
    assert.equal(dec.conditionalCommitment?.killDate, '2027-01-15');
    assert.match(dec.conditionalCommitment?.condition ?? '', /switching contractor/);
  });

  it('refuses a conditional bid with no cap — an open-ended "look into it" is what it replaces', () => {
    const opportunityId = opportunity(asOwner());
    throwsCode(
      () =>
        business.decideBidNoBid(asOwner(), opportunityId, {
          bid: true,
          rationale: 'Investigate',
          conditional: { ...commitment, spendCapMinor: 0 },
        }),
      'CONDITION_CAP_REQUIRED',
    );
  });

  it('refuses a conditional bid with no kill date', () => {
    const opportunityId = opportunity(asOwner());
    throwsCode(
      () =>
        business.decideBidNoBid(asOwner(), opportunityId, {
          bid: true,
          rationale: 'Investigate',
          conditional: { ...commitment, killDate: '' },
        }),
      'CONDITION_KILL_DATE_REQUIRED',
    );
  });

  it('refuses a conditional commitment attached to a no-bid', () => {
    const opportunityId = opportunity(asOwner(), flat(2));
    throwsCode(
      () =>
        business.decideBidNoBid(asOwner(), opportunityId, {
          bid: false,
          rationale: 'Declining',
          conditional: commitment,
        }),
      'CONDITIONAL_REQUIRES_BID',
    );
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
    // It offered "record the decision to bid on a compressed programme
    // knowingly", and there is no such decision anywhere on the platform: a way
    // forward that leads nowhere. It now names only what can actually be done.
    assert.doesNotMatch(String(error.message), /compressed programme knowingly/);
    assert.match(String(error.message), /not held up by it/);
  });

  it('builds a compressed programme when a person asks for one and says why, and marks every short stage', () => {
    // Conwy's real window: four working days. The refusal now offers this, and
    // it is never applied silently — no reason, no compression.
    const invitationId = bidding('2027-01-15T12:00');
    throwsCode(() => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11' }), 'TENDER_WINDOW_TOO_SHORT');
    throwsCode(() => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11', compression: { reason: '   ' } }), 'TENDER_WINDOW_TOO_SHORT');

    const programme = tenderintake.generateBidProgramme(asQS(), invitationId, {
      from: '2027-01-11',
      compression: { reason: 'Found the tender late; prices from our own rates, no enquiries out' },
    });
    assert.equal(programme.availableBusinessDays, 4);
    assert.equal(programme.milestones.reduce((sum, m) => sum + m.businessDays, 0), 4, 'the days that exist, all of them and no more');
    assert.equal(programme.milestones.length, tenderintake.BID_SPINE.length, 'every stage is still on it');
    assert.ok(programme.milestones.some((m) => m.belowMinimum), 'the short stages say so');
    assert.ok(programme.milestones.every((m) => m.belowMinimum === (m.businessDays < tenderintake.BID_SPINE.find((st) => st.key === m.key)!.minDays)));
    assert.equal(programme.milestones.at(-1)!.finish <= programme.submissionDay, true, 'it still finishes by the submission day');
    assert.equal(programme.compression?.normalMinimumDays, tenderintake.BID_SPINE_MINIMUM_DAYS);
    assert.match(programme.compression?.reason ?? '', /Found the tender late/);
    assert.ok(programme.compression?.acceptedBy);

    // A full-length window is never marked compressed, reason or not.
    const normal = tenderintake.generateBidProgramme(asQS(), bidding('2027-03-12T12:00'), { from: '2027-01-11', compression: { reason: 'not needed' } });
    assert.equal(normal.compression, undefined);
    assert.ok(normal.milestones.every((m) => m.belowMinimum === undefined));
  });

  it('refuses outright when no working day remains, compressed or not', () => {
    const invitationId = bidding('2027-01-11T12:00');
    throwsCode(
      () => tenderintake.generateBidProgramme(asQS(), invitationId, { from: '2027-01-11', compression: { reason: 'Last minute' } }),
      'TENDER_WINDOW_CLOSED',
    );
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

// ── Bulk-fill the return register — the one-director path ─────────────────────
describe('tender intake · assigning every blocking return at once', () => {
  it('fills owner, date and source on the mandatory returns still missing one, defaulting source to the invitation', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    // Three bare mandatory returns and one optional one.
    extract(ctx, invitationId, [
      { reference: 'R-01', title: 'Procurement questionnaire', mandatory: true },
      { reference: 'R-02', title: 'Non-collusion certificate', mandatory: true },
      { reference: 'R-03', title: 'Pricing schedule', mandatory: true },
      { reference: 'R-04', title: 'Nice to have', mandatory: false },
    ]);

    const result = tenderintake.assignDeliverablesBulk(ctx, invitationId, {
      owner: 'OWNER',
      internalDueBy: '2027-01-10',
      // No source given — it must default to the invitation these were read from.
    });
    assert.equal(result.assigned, 3, 'the three blocking mandatory returns were not all filled');
    assert.deepEqual(result.blockers, [], 'the register still blocks after a bulk fill');

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2026-12-01' });
    const r1 = position.returns.find((d) => d.reference === 'R-01')!;
    assert.equal(r1.owner, 'OWNER');
    assert.equal(r1.internalDueBy, '2027-01-10');
    assert.match(String(r1.source?.document ?? ''), /Invitation to tender/);
    // The optional return is left untouched — no owner invented for it.
    const r4 = position.returns.find((d) => d.reference === 'R-04')!;
    assert.equal(r4.owner, undefined);
  });

  it('leaves a return that already has an owner and date alone, and refuses when nothing is missing', () => {
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [complete('D-01', 'Already complete'), { reference: 'D-02', title: 'Bare', mandatory: true }]);

    const result = tenderintake.assignDeliverablesBulk(ctx, invitationId, { owner: 'OWNER', internalDueBy: '2027-01-10' });
    assert.equal(result.assigned, 1, 'the already-complete return was touched');

    const position = tenderintake.tenderPosition(ctx, invitationId, { today: '2026-12-01' });
    // The complete one kept the owner it was given, not overwritten with OWNER.
    assert.equal(position.returns.find((d) => d.reference === 'D-01')!.owner, 'QS');

    throwsCode(
      () => tenderintake.assignDeliverablesBulk(ctx, invitationId, { owner: 'OWNER', internalDueBy: '2027-01-10' }),
      'NOTHING_TO_ASSIGN',
    );
  });

  it('refuses a bulk fill that would leave every return still blocking on a missing date, instead of reporting a hollow success', () => {
    // The real defect behind "I keep assigning returns and the gate never
    // clears": the bulk door fills the source (it defaults to the invitation)
    // and the owner, so a run with no internal date changed something and read
    // as a success — yet every mandatory return still lacked its date and still
    // blocked the submission. The gate stayed at the same number with nothing
    // explaining why. The bulk door must now refuse and name the missing date.
    const ctx = pipelineCtx('qs');
    const { invitationId } = record(ctx, opportunity(ctx));
    extract(ctx, invitationId, [
      { reference: 'R-01', title: 'Procurement questionnaire', mandatory: true },
      { reference: 'R-02', title: 'Non-collusion certificate', mandatory: true },
    ]);

    throwsCode(
      // Owner given, no internal date — the shape the modal allowed before.
      () => tenderintake.assignDeliverablesBulk(ctx, invitationId, { owner: 'OWNER' }),
      'BULK_ASSIGN_INCOMPLETE',
    );

    // Nothing was written: the returns are untouched, not half-assigned.
    const stuck = tenderintake.tenderPosition(ctx, invitationId, { today: '2026-12-01' });
    assert.equal(stuck.returns.find((d) => d.reference === 'R-01')!.owner, undefined, 'a refused bulk fill still wrote a partial assignment');
    assert.equal(stuck.returns.find((d) => d.reference === 'R-01')!.source, undefined, 'a refused bulk fill still defaulted the source');

    // Supplying the date clears all of them in one act, and the register no
    // longer blocks — the gate can pass.
    const done = tenderintake.assignDeliverablesBulk(ctx, invitationId, { owner: 'OWNER', internalDueBy: '2027-01-10' });
    assert.equal(done.assigned, 2);
    assert.deepEqual(done.blockers, [], 'the register still blocks after the date was supplied');
  });
});
