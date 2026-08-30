import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as cis from '../src/domain/cis.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * The Construction Industry Scheme.
 *
 * Every figure here is worked out by hand and written into the comment, because
 * every figure here is somebody's money: too much withheld and the
 * subcontractor funds the contractor's error until the year end, too little and
 * the contractor pays the shortfall out of their own pocket.
 *
 * The three cases that cost people money have their own tests: the deduction is
 * on labour only, an unverified subcontractor is 30% and not 20%, and a month
 * with nothing in it still has a return.
 */

describe('what to withhold from one payment', () => {
  it('deducts from labour, never from materials or VAT', () => {
    // £10,000 gross, of which £3,000 is materials the subcontractor bought and
    // £1,400 is VAT. Labour is £5,600, and 20% of that is £1,120. Deducting
    // from the whole £10,000 would take £2,000 — £880 of somebody else's money.
    const result = cis.deductionFor({
      status: 'NET_20',
      grossMinor: 10_000_00,
      materialsMinor: 3_000_00,
      vatMinor: 1_400_00,
    });
    assert.equal(result.labourMinor, 5_600_00);
    assert.equal(result.deductionMinor, 1_120_00);
    assert.equal(result.netPayableMinor, 8_880_00);
  });

  it('withholds nothing from gross payment status', () => {
    const result = cis.deductionFor({ status: 'GROSS', grossMinor: 10_000_00, materialsMinor: 2_000_00 });
    assert.equal(result.deductionMinor, 0);
    assert.equal(result.netPayableMinor, 10_000_00);
  });

  it('applies the higher rate where HMRC does not hold the subcontractor', () => {
    // £4,000 of labour at 30% is £1,200.
    const result = cis.deductionFor({ status: 'UNREGISTERED', grossMinor: 4_000_00 });
    assert.equal(result.ratePercent, 30);
    assert.equal(result.deductionMinor, 1_200_00);
  });

  it('rounds the deduction down, so it never over-withholds', () => {
    // £333.33 of labour at 20% is £66.666, which is 66.66 rounded down. Rounding
    // up takes a penny that is not the Revenue's, on every payment, forever.
    const result = cis.deductionFor({ status: 'NET_20', grossMinor: 333_33 });
    assert.equal(result.deductionMinor, 66_66);
  });

  it('refuses figures that cannot all be true', () => {
    // Materials and VAT larger than the payment produce a negative labour
    // element, and a negative deduction pays the subcontractor the Revenue's
    // money. One of the three numbers is wrong and somebody has to look.
    throwsCode(
      () => cis.deductionFor({ status: 'NET_20', grossMinor: 1_000_00, materialsMinor: 900_00, vatMinor: 200_00 }),
      'CIS_MATERIALS_EXCEED_PAYMENT',
    );
  });
});

describe('the tax month, which is not the calendar month', () => {
  it('runs from the 6th to the 5th', () => {
    const month = cis.taxMonthOf('2026-05-20');
    assert.equal(month.startsOn, '2026-05-06');
    assert.equal(month.endsOn, '2026-06-05');
    assert.equal(month.returnDueBy, '2026-06-19');
    assert.equal(month.statementsDueBy, '2026-06-19');
  });

  it('puts a payment before the 6th in the month that started the month before', () => {
    // The trap. A payment on 3 June belongs to the month that began on 6 May,
    // not to the one beginning 6 June. On the wrong return this is an amendment
    // and a penalty, not a rounding difference.
    const month = cis.taxMonthOf('2026-06-03');
    assert.equal(month.startsOn, '2026-05-06');
    assert.equal(month.endsOn, '2026-06-05');
  });

  it('handles the year boundary', () => {
    const month = cis.taxMonthOf('2026-01-02');
    assert.equal(month.startsOn, '2025-12-06');
    assert.equal(month.endsOn, '2026-01-05');
    assert.equal(month.returnDueBy, '2026-01-19');
  });

  it('treats the 6th itself as the first day of the new month, not the last of the old', () => {
    const month = cis.taxMonthOf('2026-05-06');
    assert.equal(month.startsOn, '2026-05-06');
  });
});

// ── Through the ledger ──────────────────────────────────────────────────────

async function project() {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  // The QS runs the commercial cycle, which is where CIS sits.
  const ctx = () => platform.context(seed.users.qs!.auth, seed.projectId);
  return { platform, seed, ctx };
}

describe('verification', () => {
  it('records what HMRC returned, and how long it lasts', async () => {
    const p = await project();
    // Verified 10 June 2026, which is in the tax year that began 6 April 2026.
    // That year plus the two following expires 5 April 2029.
    const result = cis.recordVerification(p.ctx(), {
      supplierId: 'SUP-1',
      supplierName: 'Katanga Groundworks',
      verificationNumber: 'V1234567890',
      status: 'NET_20',
      verifiedOn: '2026-06-10',
    });
    assert.equal(result.ratePercent, 20);
    assert.equal(result.validUntil, '2029-04-05');
  });

  it('dates the tax year from April, not January', async () => {
    const p = await project();
    // 1 March 2026 falls in the year that began 6 April 2025, so it expires
    // 5 April 2028 — a year earlier than a calendar reading would give.
    const result = cis.recordVerification(p.ctx(), {
      supplierId: 'SUP-2',
      supplierName: 'Early Year Ltd',
      verificationNumber: 'V2222222222',
      status: 'GROSS',
      verifiedOn: '2026-03-01',
    });
    assert.equal(result.validUntil, '2028-04-05');
  });

  it('refuses a verification number that is not one', async () => {
    const p = await project();
    // A deduction defended at an inspection with an invented number is worse
    // than one defended with nothing, because it looks like a record.
    throwsCode(
      () =>
        cis.recordVerification(p.ctx(), {
          supplierId: 'SUP-3',
          supplierName: 'Nope Ltd',
          verificationNumber: 'not-a-number',
          status: 'NET_20',
          verifiedOn: '2026-06-10',
        }),
      'CIS_VERIFICATION_NUMBER_MALFORMED',
    );
  });

  it('refuses a status HMRC never returns', async () => {
    const p = await project();
    throwsCode(
      () =>
        cis.recordVerification(p.ctx(), {
          supplierId: 'SUP-4',
          supplierName: 'Unverified Ltd',
          verificationNumber: 'V3333333333',
          // "Not yet verified" is the absence of a verification, not a result.
          status: 'UNVERIFIED' as cis.CisStatus,
          verifiedOn: '2026-06-10',
        }),
      'CIS_STATUS_NOT_A_RESULT',
    );
  });
});

describe('paying a subcontractor', () => {
  it('takes the rate from the verification on file, not from the caller', async () => {
    // The single most expensive thing to get wrong. A contractor who believes a
    // subcontractor is on 20% and is wrong pays the difference themselves, so
    // an asserted rate must not be accepted from anywhere.
    const p = await project();
    cis.recordVerification(p.ctx(), {
      supplierId: 'SUP-1',
      supplierName: 'Katanga Groundworks',
      verificationNumber: 'V1234567890',
      status: 'NET_20',
      verifiedOn: '2026-06-10',
    });

    const payment = cis.recordPayment(p.ctx(), {
      supplierId: 'SUP-1',
      supplierName: 'Katanga Groundworks',
      grossMinor: 12_000_00,
      materialsMinor: 2_000_00,
      paidOn: '2026-06-25',
    });
    // £10,000 of labour at 20% is £2,000.
    assert.equal(payment.ratePercent, 20);
    assert.equal(payment.deductionMinor, 2_000_00);
    assert.equal(payment.verificationNumber, 'V1234567890');
    assert.match(payment.basis, /Verified 2026-06-10/);
  });

  it('applies the higher rate where nobody verified, and says whose problem that is', async () => {
    const p = await project();
    const payment = cis.recordPayment(p.ctx(), {
      supplierId: 'SUP-NEW',
      supplierName: 'Never Verified Ltd',
      grossMinor: 5_000_00,
      paidOn: '2026-06-25',
    });
    assert.equal(payment.status, 'UNVERIFIED');
    assert.equal(payment.deductionMinor, 1_500_00);
    assert.match(payment.basis, /contractor’s liability, not the subcontractor’s/);
  });

  it('uses the rate in force on the payment date, not the newest one', async () => {
    // A subcontractor gains gross status in August. A payment made in June is
    // still a 20% payment, and re-rating it retrospectively would misstate a
    // return that has already been filed.
    const p = await project();
    cis.recordVerification(p.ctx(), {
      supplierId: 'SUP-5',
      supplierName: 'Improving Ltd',
      verificationNumber: 'V4444444444',
      status: 'NET_20',
      verifiedOn: '2026-05-01',
    });
    cis.recordVerification(p.ctx(), {
      supplierId: 'SUP-5',
      supplierName: 'Improving Ltd',
      verificationNumber: 'V5555555555',
      status: 'GROSS',
      verifiedOn: '2026-08-01',
    });

    const june = cis.recordPayment(p.ctx(), {
      supplierId: 'SUP-5',
      supplierName: 'Improving Ltd',
      grossMinor: 1_000_00,
      paidOn: '2026-06-20',
    });
    assert.equal(june.ratePercent, 20, 'a June payment was rated on an August verification');

    const september = cis.recordPayment(p.ctx(), {
      supplierId: 'SUP-5',
      supplierName: 'Improving Ltd',
      grossMinor: 1_000_00,
      paidOn: '2026-09-20',
    });
    assert.equal(september.ratePercent, 0);
  });
});

describe('the monthly return', () => {
  it('adds up the month, by subcontractor', async () => {
    const p = await project();
    cis.recordVerification(p.ctx(), {
      supplierId: 'A',
      supplierName: 'Alpha Groundworks',
      verificationNumber: 'V1111111111',
      status: 'NET_20',
      verifiedOn: '2026-05-01',
    });
    // Two payments to Alpha in the same tax month, and one to an unverified
    // firm. Alpha: £8,000 labour at 20% = £1,600, then £2,000 at 20% = £400.
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha Groundworks', grossMinor: 10_000_00, materialsMinor: 2_000_00, paidOn: '2026-06-20' });
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha Groundworks', grossMinor: 2_000_00, paidOn: '2026-06-30' });
    // Beta: £1,000 at 30% = £300.
    cis.recordPayment(p.ctx(), { supplierId: 'B', supplierName: 'Beta Fencing', grossMinor: 1_000_00, paidOn: '2026-07-01' });

    const ret = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05' });
    assert.equal(ret.nil, false);
    assert.equal(ret.totals.subcontractors, 2);
    assert.equal(ret.totals.grossMinor, 13_000_00);
    assert.equal(ret.totals.materialsMinor, 2_000_00);
    assert.equal(ret.totals.deductionMinor, 1_600_00 + 400_00 + 300_00);

    const alpha = ret.lines.find((line) => line.supplierId === 'A')!;
    assert.equal(alpha.payments, 2);
    assert.equal(alpha.deductionMinor, 2_000_00);

    // The unverified one is named, because it is a job for this afternoon.
    assert.deepEqual(ret.unverified.map((u) => u.supplierId), ['B']);
    assert.match(ret.summary, /verify before the next payment/);
  });

  it('produces a nil return rather than no return', async () => {
    // The most common CIS penalty there is. A contractor who paid nobody and
    // filed nothing is £100 down the day after the 19th.
    const p = await project();
    const ret = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05' });
    assert.equal(ret.nil, true);
    assert.equal(ret.totals.deductionMinor, 0);
    assert.match(ret.summary, /A nil return is still due by 2026-07-19/);
    assert.match(ret.summary, /most common penalty/);
  });

  it('keeps a payment out of the month it did not fall in', async () => {
    const p = await project();
    // 3 July is in the month ending 5 July. 8 July is in the next one.
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 1_000_00, paidOn: '2026-07-03' });
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 5_000_00, paidOn: '2026-07-08' });

    assert.equal(cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05' }).totals.grossMinor, 1_000_00);
    assert.equal(cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-08-05' }).totals.grossMinor, 5_000_00);
  });

  it('prices the penalty for filing late', async () => {
    const p = await project();
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 100_000_00, paidOn: '2026-07-01' });

    // Due 19 July. On the 20th it is one day late and costs £100 — the same on
    // day one as on day fifty-nine, which is why the first day matters.
    const oneDay = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05', asAt: '2026-07-20' });
    assert.equal(oneDay.lateness?.daysLate, 1);
    assert.equal(oneDay.lateness?.penaltyMinor, 100_00);

    // Two months later, £200 on top.
    const twoMonths = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05', asAt: '2026-09-20' });
    assert.equal(twoMonths.lateness?.penaltyMinor, 200_00);

    // Six months: the higher of £300 and 5% of the deductions. £30,000 was
    // withheld, so 5% is £1,500 and that is what applies.
    const sixMonths = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05', asAt: '2027-02-01' });
    assert.equal(sixMonths.lateness?.penaltyMinor, 1_500_00);
    assert.match(sixMonths.lateness!.basis, /higher of £300 and 5%/);
  });

  it('carries no penalty while it is still in time', async () => {
    const p = await project();
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 1_000_00, paidOn: '2026-07-01' });
    const ret = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05', asAt: '2026-07-19' });
    assert.equal(ret.lateness, undefined);
  });

  it('says on its face that it is prepared and not filed', async () => {
    // The platform holds no Government Gateway credential. A prepared return
    // that reads as a filed one is the worst thing in this module to fake.
    const p = await project();
    const ret = cis.monthlyReturn(p.ctx(), { taxMonthEndsOn: '2026-07-05' });
    assert.match(ret.status, /Prepared, not filed/);
    assert.match(ret.status, /does not submit to HMRC/);
  });

  it('lists the months that have something in them', async () => {
    const p = await project();
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 1_000_00, paidOn: '2026-07-01' });
    cis.recordPayment(p.ctx(), { supplierId: 'A', supplierName: 'Alpha', grossMinor: 2_000_00, paidOn: '2026-08-10' });
    const board = cis.returnsBoard(p.ctx());
    assert.equal(board.length, 2);
    // Newest first, so the one that is due next is at the top.
    assert.equal(board[0]!.taxMonthEndsOn, '2026-09-05');
    assert.equal(board[1]!.taxMonthEndsOn, '2026-07-05');
  });
});
