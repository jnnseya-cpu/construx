import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as claims from '../src/engines/claims.ts';
import {
  ADJUDICATION_PERIODS,
  assessCostsProvision,
  assessProcedure,
  buildTimetable,
} from '../src/engines/maths/adjudication.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Statutory adjudication under HGCRA 1996 s.108.
 *
 * Not tender adjudication, which this platform also has and which is the
 * commercial decision closing a bid evaluation. They share a word and nothing
 * else.
 *
 * The timetable is worth holding because both ends of it are fatal in different
 * directions and neither is about the merits. Miss the seven days and the
 * appointment is a nullity. Miss the twenty-eight and the decision is. Parties
 * lose adjudications they should have won by watching the argument instead of
 * the dates, which is exactly the sort of thing a platform can be sure about.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
const contractId = () => platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;

describe('the referral clock', () => {
  it('runs seven days from the notice, counted plainly', () => {
    // Seven days is not less than seven, so s.116(3) does not reach it and the
    // deadline lands where the arithmetic puts it.
    const timetable = buildTimetable({ noticeDate: '2026-09-01' });
    assert.equal(timetable.referralDeadline, '2026-09-08');
    assert.equal(ADJUDICATION_PERIODS.referralDays, 7);
  });

  it('reports a serve-by date where the deadline is not a business day', () => {
    // The statutory date does not move. What moves is the practical answer to
    // when it has to leave your office.
    const timetable = buildTimetable({ noticeDate: '2026-08-22' }); // deadline Saturday 29th
    assert.equal(timetable.referralDeadline, '2026-08-29');
    assert.equal(timetable.referralServeByMoved, true);
    assert.equal(timetable.referralServeBy, '2026-08-28');
  });

  it('says the reference is in jeopardy when the referral is late, not that the right is lost', () => {
    const timetable = buildTimetable({ noticeDate: '2026-09-01', referralDate: '2026-09-11' });
    assert.equal(timetable.referredInTime, false);
    assert.equal(timetable.referralDaysTaken, 10);

    const findings = assessProcedure(timetable, { status: 'REFERRED' }, '2026-09-11');
    const jurisdiction = findings.find((f) => f.authority.includes('s.108(2)(b)'));

    assert.ok(jurisdiction);
    assert.equal(jurisdiction.severity, 'CRITICAL');
    assert.match(jurisdiction.consequence, /jurisdiction/i);
  });

  it('escalates once the referral period has simply run out', () => {
    const timetable = buildTimetable({ noticeDate: '2026-09-01' });
    const inTime = assessProcedure(timetable, { status: 'NOTICE_GIVEN' }, '2026-09-04');
    const expired = assessProcedure(timetable, { status: 'NOTICE_GIVEN' }, '2026-09-20');

    assert.equal(inTime[0]!.severity, 'WARNING');
    assert.equal(expired[0]!.severity, 'CRITICAL');
    assert.match(expired[0]!.consequence, /fresh notice/i, 'the right arises at any time — it is this reference that is lost');
  });
});

describe('the decision clock', () => {
  it('runs twenty-eight days from the referral, not from the notice', () => {
    const timetable = buildTimetable({ noticeDate: '2026-09-01', referralDate: '2026-09-07' });
    assert.equal(timetable.decisionDeadline, '2026-10-05');
    assert.equal(ADJUDICATION_PERIODS.decisionDays, 28);
  });

  it('extends by fourteen days on the referring party alone', () => {
    const timetable = buildTimetable({
      noticeDate: '2026-09-01',
      referralDate: '2026-09-07',
      extensionDays: 14,
      extensionAgreedBy: 'REFERRING_PARTY',
      extensionAgreedDate: '2026-09-25',
    });

    assert.equal(timetable.extensionValid, true);
    assert.equal(timetable.extendedDecisionDeadline, '2026-10-19');
    assert.match(timetable.extensionAuthority ?? '', /s\.108\(2\)\(d\)/);
  });

  it('refuses more than fourteen on the referring party alone', () => {
    const timetable = buildTimetable({
      noticeDate: '2026-09-01',
      referralDate: '2026-09-07',
      extensionDays: 21,
      extensionAgreedBy: 'REFERRING_PARTY',
      extensionAgreedDate: '2026-09-25',
    });

    assert.equal(timetable.extensionValid, false);
    assert.equal(timetable.extendedDecisionDeadline, timetable.decisionDeadline, 'the deadline stays where it was');
    assert.match(timetable.extensionAuthority ?? '', /needs both parties/);
  });

  it('allows a longer extension where both parties agreed it after referral', () => {
    const timetable = buildTimetable({
      noticeDate: '2026-09-01',
      referralDate: '2026-09-07',
      extensionDays: 42,
      extensionAgreedBy: 'BOTH_PARTIES',
      extensionAgreedDate: '2026-09-25',
    });

    assert.equal(timetable.extensionValid, true);
    assert.match(timetable.extensionAuthority ?? '', /after referral/);
  });

  it('rejects consent given before the dispute was referred', () => {
    // s.108(2)(e) requires the agreement to be made after referral. A clause
    // agreeing in advance to whatever the adjudicator asks for is not consent.
    const timetable = buildTimetable({
      noticeDate: '2026-09-01',
      referralDate: '2026-09-07',
      extensionDays: 14,
      extensionAgreedBy: 'BOTH_PARTIES',
      extensionAgreedDate: '2026-09-02',
    });

    assert.equal(timetable.extensionValid, false);
    assert.match(timetable.extensionAuthority ?? '', /after the dispute was referred/);
  });

  it('calls a decision one day late a nullity, in those terms', () => {
    const timetable = buildTimetable({ noticeDate: '2026-09-01', referralDate: '2026-09-07' });
    const findings = assessProcedure(timetable, { decisionDate: '2026-10-06', status: 'DECIDED' }, '2026-10-06');
    const decision = findings.find((f) => f.authority.includes('s.108(2)(c)'));

    assert.ok(decision);
    assert.equal(decision.severity, 'CRITICAL');
    assert.match(decision.consequence, /nullity/);
    assert.match(decision.consequence, /paid the adjudicator/);
  });

  it('says a decision in time binds only until the dispute is finally determined', () => {
    // Temporarily binding is still binding, which is the part parties
    // reliably get wrong in both directions.
    const timetable = buildTimetable({ noticeDate: '2026-09-01', referralDate: '2026-09-07' });
    const findings = assessProcedure(timetable, { decisionDate: '2026-10-02', status: 'DECIDED' }, '2026-10-02');
    const decision = findings.find((f) => f.authority.includes('s.108(2)(c)'));

    assert.equal(decision?.severity, 'INFO');
    assert.match(decision?.consequence ?? '', /binds the parties until/);
    assert.match(decision?.consequence ?? '', /complied with in the meantime/);
  });

  it('warns as the period closes rather than only once it has gone', () => {
    const timetable = buildTimetable({ noticeDate: '2026-09-01', referralDate: '2026-09-07' });
    const early = assessProcedure(timetable, { status: 'REFERRED' }, '2026-09-10');
    const closing = assessProcedure(timetable, { status: 'REFERRED' }, '2026-10-01');
    const gone = assessProcedure(timetable, { status: 'REFERRED' }, '2026-10-10');

    assert.equal(early.at(-1)!.severity, 'INFO');
    assert.equal(closing.at(-1)!.severity, 'WARNING');
    assert.equal(gone.at(-1)!.severity, 'CRITICAL');
  });
});

describe('s.108A — who pays', () => {
  it('holds a Tolent clause ineffective', () => {
    // Inserted to kill a term making the referring party bear both sides' costs
    // whatever the outcome, which made the statutory right too expensive to use
    // and so defeated it.
    const findings = assessCostsProvision({ contractAllocatesPartiesCosts: true });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'CRITICAL');
    assert.match(findings[0]!.consequence, /Ineffective/);
    assert.match(findings[0]!.consequence, /not a reason to leave a dispute unreferred/);
  });

  it('allows the one route by which such an agreement binds', () => {
    const findings = assessCostsProvision({ contractAllocatesPartiesCosts: true, agreedInWritingAfterNotice: true });
    assert.equal(findings[0]!.severity, 'INFO');
    assert.match(findings[0]!.finding, /after the notice of adjudication/);
  });

  it('says nothing where the contract is silent', () => {
    assert.deepEqual(assessCostsProvision({ contractAllocatesPartiesCosts: false }), []);
  });
});

describe('a dispute through the platform', () => {
  let disputeId: string;

  it('will not open on a notice that does not say what the dispute is', () => {
    // The adjudicator has jurisdiction over the dispute referred and nothing
    // else, so a vague notice is a gift to the other side.
    throwsCode(
      () =>
        claims.openDispute(ctx('qs'), {
          contractId: contractId(),
          natureOfDispute: 'Money owed',
          redressSought: 'Payment of the sum applied for',
          referringParty: 'Meridian Infrastructure Group',
          respondingParty: 'Ashworth Water Authority',
          noticeDate: '2026-09-01',
          evidenceHash: hashEvidence('notice-vague'),
        }),
      'DISPUTE_NOT_DEFINED',
    );
  });

  it('opens on a notice that does, and starts the clock', () => {
    const result = claims.openDispute(ctx('qs'), {
      contractId: contractId(),
      natureOfDispute:
        'Failure to pay the notified sum for interim application 4 in the absence of a valid payment notice or pay less notice.',
      redressSought: 'Payment of the notified sum of £412,000 together with statutory interest.',
      disputedAmountMinor: 41_200_000,
      referringParty: 'Meridian Infrastructure Group',
      respondingParty: 'Ashworth Water Authority',
      noticeDate: '2026-09-01',
      evidenceHash: hashEvidence('notice-of-adjudication-1'),
    });

    disputeId = result.disputeId;
    assert.match(result.reference, /^ADJ-/);
    assert.equal(result.timetable.referralDeadline, '2026-09-08');

    const record = platform.ledger.require({ refType: 'Dispute', refId: disputeId });
    assert.equal(record.state.status, 'NOTICE_GIVEN');
  });

  it('records the referral and the appointment', () => {
    const result = claims.referDispute(ctx('qs'), {
      disputeId,
      adjudicatorName: 'A. Adjudicator FRICS',
      nominatingBody: 'RICS',
      referralDate: '2026-09-07',
      evidenceHash: hashEvidence('referral-1'),
    });

    assert.equal(result.timetable.referredInTime, true);
    assert.equal(result.timetable.decisionDeadline, '2026-10-05');
    assert.equal(platform.ledger.require({ refType: 'Dispute', refId: disputeId }).state.status, 'REFERRED');
  });

  it('will not refer the same dispute twice', () => {
    throwsCode(
      () =>
        claims.referDispute(ctx('qs'), {
          disputeId,
          adjudicatorName: 'Somebody else',
          referralDate: '2026-09-08',
          evidenceHash: hashEvidence('referral-2'),
        }),
      'DISPUTE_ALREADY_REFERRED',
    );
  });

  it('records a decision reached in time as enforceable', () => {
    const result = claims.recordAdjudicatorDecision(ctx('qs'), {
      disputeId,
      decisionDate: '2026-10-02',
      inFavourOf: 'Meridian Infrastructure Group',
      awardedAmountMinor: 41_200_000,
      adjudicatorFeesMinor: 890_000,
      feesBorneBy: 'Ashworth Water Authority',
      evidenceHash: hashEvidence('decision-1'),
    });

    assert.equal(result.enforceable, true);
    const record = platform.ledger.require({ refType: 'Dispute', refId: disputeId });
    assert.equal(record.state.status, 'DECIDED');
    assert.equal(record.state.bindingUntilFinallyDetermined, true);
  });

  it('will not record a decision on a dispute that was never referred', () => {
    const fresh = claims.openDispute(ctx('qs'), {
      contractId: contractId(),
      natureOfDispute: 'Valuation of the wall thickness variation and its effect on the completion date.',
      redressSought: 'A declaration as to the correct valuation and an extension of time of 14 days.',
      referringParty: 'Meridian Infrastructure Group',
      respondingParty: 'Ashworth Water Authority',
      noticeDate: '2026-10-01',
      evidenceHash: hashEvidence('notice-of-adjudication-2'),
    });

    throwsCode(
      () =>
        claims.recordAdjudicatorDecision(ctx('qs'), {
          disputeId: fresh.disputeId,
          decisionDate: '2026-10-20',
          inFavourOf: 'Nobody',
          evidenceHash: hashEvidence('decision-2'),
        }),
      'DISPUTE_NOT_REFERRED',
    );
  });

  it('records an out-of-time decision rather than refusing it', () => {
    // Refusing the record would leave the party with nothing in front of them
    // at the moment they are deciding whether to pay against it.
    const late = claims.openDispute(ctx('qs'), {
      contractId: contractId(),
      natureOfDispute: 'Entitlement to an extension of time for the exceptional adverse weather in July 2026.',
      redressSought: 'An extension of time of 11 days and relief from liquidated damages.',
      referringParty: 'Meridian Infrastructure Group',
      respondingParty: 'Ashworth Water Authority',
      noticeDate: '2026-07-01',
      evidenceHash: hashEvidence('notice-of-adjudication-3'),
    });
    claims.referDispute(ctx('qs'), {
      disputeId: late.disputeId,
      adjudicatorName: 'B. Adjudicator FCIArb',
      referralDate: '2026-07-06',
      evidenceHash: hashEvidence('referral-3'),
    });

    const result = claims.recordAdjudicatorDecision(ctx('qs'), {
      disputeId: late.disputeId,
      decisionDate: '2026-08-20', // 45 days after referral, no extension
      inFavourOf: 'Meridian Infrastructure Group',
      awardedDays: 11,
      evidenceHash: hashEvidence('decision-3'),
    });

    assert.equal(result.enforceable, false);
    assert.equal(platform.ledger.require({ refType: 'Dispute', refId: late.disputeId }).state.bindingUntilFinallyDetermined, false);
    assert.ok(result.findings.some((f) => f.consequence.includes('nullity')));
  });

  it('orders the position by the deadline that expires soonest', () => {
    const position = claims.disputePosition(ctx('qs'), '2026-10-03');

    assert.ok(position.total >= 3);
    const withDeadlines = position.disputes.filter((d) => d.nextDeadline);
    for (let i = 1; i < withDeadlines.length; i++) {
      assert.ok(withDeadlines[i - 1]!.nextDeadline! <= withDeadlines[i]!.nextDeadline!);
    }
    assert.ok(position.summary.length > 20);
  });

  it('refuses the register to a role without legal clearance', () => {
    // Dispute records are LEGAL_L4. A safety lead has no business reading the
    // contractual position on a live adjudication.
    assert.throws(() => claims.disputePosition(platform.context(seed.users.safety!.auth, seed.projectId)), /ACCESS_DENIED|holds/);
  });
});
