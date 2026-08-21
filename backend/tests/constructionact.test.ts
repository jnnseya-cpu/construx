import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as cost from '../src/engines/cost.ts';
import {
  addBusinessDays,
  assessCycle,
  assessPaymentTerms,
  bankHolidays,
  businessDayOnOrBefore,
  businessDaysBetween,
  compliancePosition,
  isBusinessDay,
  reckonPeriod,
  SCHEME_DEFAULTS,
  type CycleInput,
} from '../src/engines/maths/constructionAct.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The Construction Act.
 *
 * These tests are about money that moves for reasons unrelated to the value of
 * the work. Every assertion below encodes a rule where a contractor who is
 * entirely right about the building can still lose the argument on a date.
 */

describe('the business day calendar', () => {
  it('derives the Easter holidays rather than listing them', () => {
    // Easter Sunday 2026 is 5 April, so Good Friday is the 3rd and Easter
    // Monday the 6th. A hardcoded table would be wrong by 2027.
    const holidays = bankHolidays(2026);
    assert.ok(holidays.includes('2026-04-03'), 'Good Friday');
    assert.ok(holidays.includes('2026-04-06'), 'Easter Monday');

    const next = bankHolidays(2027);
    assert.ok(next.includes('2027-03-26'), 'Good Friday 2027 moves with Easter');
    assert.ok(next.includes('2027-03-29'), 'Easter Monday 2027');
  });

  it('gives two distinct substitute days when Christmas and Boxing Day fall at a weekend', () => {
    // 25 December 2027 is a Saturday and the 26th a Sunday. The substitutes are
    // the Monday and the Tuesday — collapsing them onto one day would hand a
    // payer an extra working day that does not exist.
    const holidays = bankHolidays(2027);
    assert.ok(holidays.includes('2027-12-27'), 'Christmas substitute');
    assert.ok(holidays.includes('2027-12-28'), 'Boxing Day substitute');
  });

  it('substitutes New Year when it falls at a weekend', () => {
    // 1 January 2028 is a Saturday.
    assert.ok(bankHolidays(2028).includes('2028-01-03'));
  });

  it('knows the jurisdictions keep different days', () => {
    const englandWales = bankHolidays(2026, 'ENGLAND_WALES');
    const scotland = bankHolidays(2026, 'SCOTLAND');
    const northernIreland = bankHolidays(2026, 'NORTHERN_IRELAND');

    assert.ok(scotland.includes('2026-01-02'), 'Scotland keeps 2 January');
    assert.ok(!englandWales.includes('2026-01-02'));
    assert.ok(!scotland.includes('2026-04-06'), 'Scotland has no Easter Monday');
    assert.ok(englandWales.includes('2026-04-06'));
    assert.ok(scotland.includes('2026-11-30'), "St Andrew's Day");
    assert.ok(northernIreland.includes('2026-03-17'), "St Patrick's Day");
    assert.ok(northernIreland.includes('2026-07-13'), 'Battle of the Boyne substitute — the 12th is a Sunday in 2026');

    // Scotland takes the first Monday in August; England and Wales the last.
    assert.ok(scotland.includes('2026-08-03'));
    assert.ok(englandWales.includes('2026-08-31'));
  });

  it('accepts a proclaimed holiday it could never have derived', () => {
    // A coronation or state funeral is created by royal proclamation. No rule
    // produces it, so the calendar takes it as input rather than guessing.
    const calendar = { jurisdiction: 'ENGLAND_WALES' as const, additionalHolidays: ['2026-06-15'] };
    assert.equal(isBusinessDay('2026-06-15', calendar), false);
    assert.equal(isBusinessDay('2026-06-15'), true, 'and it is an ordinary Monday without it');
  });

  it('rolls back across the whole Christmas run', () => {
    // 26 December 2026 is a Saturday, so the substitutes run into the following
    // week. The last business day before New Year's Eve week starts is the 24th.
    assert.equal(businessDayOnOrBefore('2026-12-27'), '2026-12-24');
  });

  it('counts business days for the contracts that count that way', () => {
    // Thursday 2 April 2026 plus five business days crosses Good Friday and
    // Easter Monday, so it lands on the 13th rather than the 9th.
    assert.equal(addBusinessDays('2026-04-02', 5), '2026-04-13');
    assert.equal(businessDaysBetween('2026-04-02', '2026-04-13'), 5);
    assert.equal(businessDaysBetween('2026-04-13', '2026-04-02'), -5, 'and it is signed');
  });
});

describe('s.116 — the exception that turns on how long the period is', () => {
  it('counts seven days or more plainly, holidays and all', () => {
    // The general rule. The Act says days and a court reads days, so a deadline
    // landing on a bank holiday stays there and the serve-by date deals with it.
    assert.equal(reckonPeriod('2026-12-21', 7), '2026-12-28', 'the Boxing Day substitute, unmoved');
    assert.equal(reckonPeriod('2026-04-01', 17), '2026-04-18', 'straight through Easter');
  });

  it('excludes Christmas, Good Friday and bank holidays from a period under seven days', () => {
    // The Scheme's payment notice period is five days, which puts it inside
    // s.116(3). Counting it plainly lands on 26 December; the statute does not.
    assert.equal(reckonPeriod('2026-12-21', 5), '2026-12-29');
  });

  it('still counts Saturdays and Sundays', () => {
    // s.116(3) names three categories and the weekend is not among them.
    // Treating it as a business-day count pushes every short deadline out.
    assert.equal(reckonPeriod('2026-06-04', 5), '2026-06-09', 'straight across a weekend');
    assert.notEqual(reckonPeriod('2026-06-04', 5), addBusinessDays('2026-06-04', 5));
  });

  it('excludes Christmas Day even when it falls at a weekend', () => {
    // 25 December 2027 is a Saturday. The business day calendar carries only
    // the substitute, because Saturday was never a working day — but here a
    // Saturday counts, so the day itself has to be excluded explicitly.
    assert.ok(!bankHolidays(2027).includes('2027-12-25'));
    assert.equal(reckonPeriod('2027-12-23', 3), '2027-12-29');
  });

  it('excludes Boxing Day on a Saturday, which is a bank holiday all the same', () => {
    // 26 December 2026 is a Saturday. It is appointed "if it be not a Sunday",
    // so it is a holiday and the Monday substitute is another.
    assert.equal(reckonPeriod('2026-12-24', 1), '2026-12-27', 'past Christmas Day and Boxing Day, onto the Sunday');
  });

  it('is jurisdiction-aware, because the holidays are', () => {
    // New Year's Day 2027 is a Friday, so it is excluded in both. Then the
    // paths part: 2 January is a Saturday, an ordinary counting day in England
    // and a bank holiday in Scotland.
    const scotland = { jurisdiction: 'SCOTLAND' as const, additionalHolidays: [] };
    assert.equal(reckonPeriod('2026-12-31', 1), '2027-01-02', 'England: the Saturday counts');
    assert.equal(reckonPeriod('2026-12-31', 1, scotland), '2027-01-03', 'Scotland: 2 January is excluded too');
  });

  it('honours a proclaimed one-off holiday nobody can derive', () => {
    // A coronation or a jubilee is created by proclamation and cannot be
    // derived from a rule, so it is supplied rather than guessed at.
    const withJubilee = { jurisdiction: 'ENGLAND_WALES' as const, additionalHolidays: ['2026-06-08'] };
    assert.equal(reckonPeriod('2026-06-06', 2), '2026-06-08');
    assert.equal(reckonPeriod('2026-06-06', 2, withJubilee), '2026-06-09');
  });

  it('returns the date itself for a period of nothing', () => {
    assert.equal(reckonPeriod('2026-06-05', 0), '2026-06-05');
  });
});

describe('payment terms against the Act', () => {
  const compliant = {
    applicationDayOfMonth: 25,
    paymentNoticeDays: 5,
    payLessNoticeDaysBeforeFinal: 7,
    finalDateDays: 17,
  };

  it('accepts terms that meet the Act without inventing a complaint', () => {
    const findings = assessPaymentTerms(compliant);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'COMPLIANT');
  });

  it('strikes out a payment notice period longer than the statute allows', () => {
    const findings = assessPaymentTerms({ ...compliant, paymentNoticeDays: 10 });
    const void_ = findings.find((f) => f.severity === 'VOID');
    assert.ok(void_);
    assert.match(void_.authority, /s\.110A/);
    // The consequence is the part that matters: a payer relying on the
    // contractual date gives a notice that has no effect.
    assert.match(void_.consequence, /out of time/);
  });

  it('strikes out a pay less period that expires before the sum is due', () => {
    const findings = assessPaymentTerms({ ...compliant, payLessNoticeDaysBeforeFinal: 20, finalDateDays: 17 });
    const void_ = findings.find((f) => f.severity === 'VOID');
    assert.ok(void_);
    assert.match(void_.finding, /expires on or before the due date/);
  });

  it('separates a term that is bad from a term that is void', () => {
    // 60-day payment is lawful and ruinous. Reporting it as a legal defect
    // would be wrong, and staying silent would be worse.
    const findings = assessPaymentTerms({ ...compliant, finalDateDays: 60 });
    assert.equal(findings.filter((f) => f.severity === 'VOID').length, 0);
    const onerous = findings.find((f) => f.severity === 'ONEROUS');
    assert.ok(onerous);
    assert.match(onerous.consequence, /43 additional days/);
  });

  it('says plainly when there is no statutory right to interim payment at all', () => {
    const findings = assessPaymentTerms(compliant, 30);
    const short = findings.find((f) => f.authority.includes('s.109'));
    assert.ok(short);
    assert.match(short.consequence, /no statutory entitlement/);
  });
});

describe('the statutory position on a payment cycle', () => {
  const base: CycleInput = {
    cycleNumber: 1,
    dueDate: '2026-03-25',
    paymentNoticeDeadline: '2026-03-30',
    payLessNoticeDeadline: '2026-04-04',
    finalDateForPayment: '2026-04-11',
    appliedMinor: 50_000_00,
  };

  it('makes no finding before the payment notice is even due', () => {
    const position = assessCycle(base, '2026-03-26');
    assert.equal(position.notifiedSumSource, 'NOT_YET_DETERMINED');
    assert.equal(position.exposureMinor, 0);
    assert.equal(position.findings.filter((f) => f.severity === 'CRITICAL').length, 0);
  });

  it('turns the application into the notified sum when both notices are missed', () => {
    const position = assessCycle(base, '2026-03-31');
    assert.equal(position.notifiedSumSource, 'APPLICATION_BY_DEFAULT');
    assert.equal(position.notifiedSumMinor, 50_000_00);
    // Nothing was ever notified, so the whole application is exposure.
    assert.equal(position.exposureMinor, 50_000_00);
    const critical = position.findings.find((f) => f.severity === 'CRITICAL');
    assert.ok(critical);
    assert.match(critical.consequence, /regardless of the true value of the work/);
  });

  it('treats a late payment notice as no notice, and prices the difference', () => {
    const position = assessCycle(
      { ...base, paymentNotice: { issuedDate: '2026-04-01', sumMinor: 30_000_00, basisStated: true } },
      '2026-04-02',
    );
    assert.equal(position.notifiedSumSource, 'APPLICATION_BY_DEFAULT');
    assert.equal(position.notifiedSumMinor, 50_000_00);
    // The payer meant to pay £30,000 and now owes £50,000. £20,000 is the cost
    // of the missed date, and it has nothing to do with the work.
    assert.equal(position.exposureMinor, 20_000_00);
    assert.ok(position.findings.some((f) => /s\.110A/.test(f.authority)));
  });

  it('lets a valid pay less notice do its job', () => {
    const position = assessCycle(
      {
        ...base,
        paymentNotice: { issuedDate: '2026-03-28', sumMinor: 45_000_00, basisStated: true },
        payLessNotice: { issuedDate: '2026-04-02', sumMinor: 38_000_00, basisStated: true },
      },
      '2026-04-05',
    );
    assert.equal(position.notifiedSumSource, 'PAY_LESS_NOTICE');
    assert.equal(position.notifiedSumMinor, 38_000_00);
    assert.equal(position.exposureMinor, 0, 'a notice that works costs nothing');
  });

  it('invalidates a pay less notice that states a sum but not the basis', () => {
    // This is the rule that catches people. The notice was in time, the figure
    // was reasoned, and it is worth nothing because the reasoning was not on it.
    const position = assessCycle(
      {
        ...base,
        paymentNotice: { issuedDate: '2026-03-28', sumMinor: 45_000_00, basisStated: true },
        payLessNotice: { issuedDate: '2026-04-02', sumMinor: 38_000_00, basisStated: false },
      },
      '2026-04-05',
    );
    assert.equal(position.notifiedSumSource, 'PAYMENT_NOTICE');
    assert.equal(position.notifiedSumMinor, 45_000_00);
    assert.equal(position.exposureMinor, 7_000_00);
    assert.ok(position.findings.some((f) => /s\.111\(4\)/.test(f.authority)));
  });

  it('records a late pay less notice as ineffective and names the date it died', () => {
    const position = assessCycle(
      {
        ...base,
        paymentNotice: { issuedDate: '2026-03-28', sumMinor: 45_000_00, basisStated: true },
        payLessNotice: { issuedDate: '2026-04-06', sumMinor: 38_000_00, basisStated: true },
      },
      '2026-04-07',
    );
    assert.equal(position.notifiedSumMinor, 45_000_00);
    assert.equal(position.exposureMinor, 7_000_00);
    const finding = position.findings.find((f) => /s\.111\(5\)/.test(f.authority));
    assert.ok(finding);
    assert.match(finding.finding, /2026-04-04/, 'the deadline it missed is stated, not implied');
  });

  it('opens the right to suspend once the final date passes unpaid', () => {
    const position = assessCycle(
      { ...base, paymentNotice: { issuedDate: '2026-03-28', sumMinor: 45_000_00, basisStated: true }, paidMinor: 0 },
      '2026-04-12',
    );
    assert.equal(position.shortfallMinor, 45_000_00);
    assert.equal(position.suspensionAvailable, true);
    assert.equal(position.suspensionEarliestDate, '2026-04-19', "seven days' notice from today");
  });

  it('states the interest entitlement without inventing the rate', () => {
    const position = assessCycle(
      { ...base, paymentNotice: { issuedDate: '2026-03-28', sumMinor: 45_000_00, basisStated: true }, paidMinor: 0 },
      '2026-04-12',
    );
    const interest = position.findings.find((f) => /base rate/.test(f.consequence));
    assert.ok(interest);
    assert.match(interest.consequence, /plus 8%/);
    // The base rate is a fact about the outside world. Reporting a number here
    // would be reporting a guess as a debt.
    assert.match(interest.consequence, /not held by the platform/);
    assert.doesNotMatch(interest.consequence, /£/);
  });

  it('does not move a statutory deadline off a bank holiday, but says to serve earlier', () => {
    // Good Friday 2026 is 3 April.
    const position = assessCycle({ ...base, payLessNoticeDeadline: '2026-04-03' }, '2026-03-26');
    const deadline = position.deadlines.find((d) => d.notice === 'Pay less notice');
    assert.ok(deadline);
    assert.equal(deadline.statutoryDate, '2026-04-03', 'the statute does not know about Easter');
    assert.equal(deadline.serveBy, '2026-04-02');
    assert.equal(deadline.movedForService, true);

    const warning = position.findings.find((f) => f.authority === 'Service');
    assert.ok(warning);
    assert.match(warning.consequence, /statutory date does not move/);
  });

  it('does not nag about a service date that has already passed', () => {
    const position = assessCycle({ ...base, payLessNoticeDeadline: '2026-04-03' }, '2026-05-01');
    assert.equal(position.findings.filter((f) => f.authority === 'Service').length, 0);
  });
});

describe('the contract-wide compliance position', () => {
  const cycle = (n: number, month: string, applied: number): CycleInput => ({
    cycleNumber: n,
    dueDate: `2026-${month}-25`,
    paymentNoticeDeadline: `2026-${month}-30`,
    payLessNoticeDeadline: `2026-${month}-28`,
    finalDateForPayment: `2026-${month}-30`,
    appliedMinor: applied,
  });

  it('totals the exposure across cycles and counts the failures', () => {
    const position = compliancePosition([cycle(1, '03', 10_000_00), cycle(2, '04', 20_000_00)], '2026-05-01');
    assert.equal(position.totalExposureMinor, 30_000_00);
    assert.equal(position.criticalCount >= 2, true);
    assert.match(position.summary, /statutory failures/);
  });

  it('says so plainly when the position is clean', () => {
    const position = compliancePosition(
      [
        {
          ...cycle(1, '03', 10_000_00),
          paymentNotice: { issuedDate: '2026-03-26', sumMinor: 10_000_00, basisStated: true },
          paidMinor: 10_000_00,
        },
      ],
      '2026-05-01',
    );
    assert.equal(position.totalExposureMinor, 0);
    assert.equal(position.criticalCount, 0);
    assert.match(position.summary, /clean across 1 cycle/);
  });

  it('names the next thing somebody has to do, and how long is left', () => {
    const position = compliancePosition([cycle(6, '08', 10_000_00)], '2026-08-20');
    assert.ok(position.nextAction);
    assert.equal(position.nextAction.cycleNumber, 6);
    assert.ok(position.nextAction.daysRemaining > 0);
  });
});

describe('the pay less notice, which the platform previously could not issue', () => {
  let platform: Platform;
  let seed: SeedResult;
  let applicationId: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    // The third application is certified short and unpaid, which is exactly the
    // position a pay less notice exists for.
    applicationId = String(
      platform.ledger
        .list(seed.projectId, 'PaymentApplication')
        .find((a) => Number(a.state.cycleNumber) === 3)!.refId,
    );
  });

  const context = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

  it('refuses a bare figure, because a figure is not a notice', () => {
    throwsCode(
      () =>
        cost.issuePayLessNotice(context('owner'), {
          applicationId,
          sumConsideredDueMinor: 100_000_00,
          basis: 'Defects',
          issuedDate: '2026-11-10',
          noticeHash: hashEvidence('pln-bare'),
        }),
      'PAY_LESS_BASIS_REQUIRED',
    );
  });

  it('refuses a sum above the notified sum, which would not be paying less', () => {
    throwsCode(
      () =>
        cost.issuePayLessNotice(context('owner'), {
          applicationId,
          sumConsideredDueMinor: 900_000_000_00,
          basis: 'Revised valuation of the structural frame and associated temporary works',
          issuedDate: '2026-11-10',
          noticeHash: hashEvidence('pln-too-high'),
        }),
      'PAY_LESS_EXCEEDS_NOTIFIED_SUM',
    );
  });

  it('will not let the applying party give the payer notice', () => {
    // The QS submitted the application. Separation of duties is the same rule
    // that keeps certification away from the applicant.
    assert.throws(() =>
      cost.issuePayLessNotice(context('qs'), {
        applicationId,
        sumConsideredDueMinor: 100_000_00,
        basis: 'Revised valuation of the structural frame and associated temporary works',
        issuedDate: '2026-11-10',
        noticeHash: hashEvidence('pln-wrong-party'),
      }),
    );
  });

  it('issues the notice and records what was withheld and on what basis', () => {
    const result = cost.issuePayLessNotice(context('owner'), {
      applicationId,
      sumConsideredDueMinor: 200_000_000,
      basis: 'Dewatering rates not agreed and handrail terminations not to the approved detail',
      issuedDate: '2026-11-10',
      noticeHash: hashEvidence('pln-valid'),
    });

    assert.equal(result.inTime, true);
    assert.equal(result.effective, true);
    assert.match(result.reference, /^PLN-\d{4}$/);

    const record = platform.ledger.require({ refType: 'PayLessNotice', refId: result.noticeId });
    assert.equal(record.state.sumConsideredDueMinor, 200_000_000);
    assert.equal(record.state.withheldMinor, 212_900_000 - 200_000_000);
    assert.equal(record.state.basisStated, true);
  });

  it('records a late notice rather than refusing it, and marks it ineffective', () => {
    // Refusing would destroy the evidence of what was said and when — the very
    // record needed to argue about waiver later.
    const application4 = cost.submitApplication(context('qs'), {
      cycleId: String(platform.ledger.list(seed.projectId, 'PaymentCycle')[0]!.refId),
      cycleNumber: 4,
      grossValuationMinor: 700_000_000,
      variationsIncludedMinor: 0,
      previouslyCertifiedMinor: 620_000_000,
      retentionMinor: 2_400_000,
      supportingEvidenceHash: hashEvidence('application-4'),
    });

    const result = cost.issuePayLessNotice(context('owner'), {
      applicationId: application4.applicationId,
      sumConsideredDueMinor: 50_000_000,
      basis: 'Works not executed in the period claimed and no supporting measure provided',
      issuedDate: '2027-06-01',
      noticeHash: hashEvidence('pln-late'),
    });

    assert.equal(result.inTime, false);
    assert.equal(result.effective, false);
    const record = platform.ledger.require({ refType: 'PayLessNotice', refId: result.noticeId });
    assert.equal(record.state.effective, false);
  });

  it('reads the statutory position back off the ledger', () => {
    const cycleId = String(platform.ledger.list(seed.projectId, 'PaymentCycle')[0]!.refId);
    const position = cost.statutoryPosition(context('qs'), cycleId, '2027-07-01');

    const third = position.cycles.find((c) => c.cycleNumber === 3);
    assert.ok(third);
    // A payment notice given in time is the notified sum. Certifying less than
    // was applied for is lawful; it is going below the *notified* sum that needs
    // a pay less notice.
    assert.equal(third.notifiedSumSource, 'PAY_LESS_NOTICE');
    assert.equal(third.notifiedSumMinor, 200_000_000);

    const fourth = position.cycles.find((c) => c.cycleNumber === 4);
    assert.ok(fourth);
    assert.equal(fourth.notifiedSumSource, 'APPLICATION_BY_DEFAULT', 'the late notice has no effect');
    assert.ok(fourth.exposureMinor > 0);
  });

  it('assesses the contract terms in the same answer', () => {
    const cycleId = String(platform.ledger.list(seed.projectId, 'PaymentCycle')[0]!.refId);
    const position = cost.statutoryPosition(context('qs'), cycleId, '2027-07-01');
    // The demo contract pays at 30 days, which the Act permits and a small
    // contractor funds.
    assert.ok(position.terms.some((t) => t.severity === 'ONEROUS' || t.severity === 'COMPLIANT'));
    assert.equal(position.terms.filter((t) => t.severity === 'VOID').length, 0);
  });

  it('publishes the Scheme fallbacks as constants rather than scattering them', () => {
    assert.equal(SCHEME_DEFAULTS.paymentNoticeDays, 5);
    assert.equal(SCHEME_DEFAULTS.finalDateDays, 17);
    assert.equal(SCHEME_DEFAULTS.payLessNoticeDaysBeforeFinal, 7);
    assert.equal(SCHEME_DEFAULTS.suspensionNoticeDays, 7);
  });
});
