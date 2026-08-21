import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { hashEvidence } from '../src/core/canonical.ts';
import * as cost from '../src/engines/cost.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Cash as the record says it will be, rather than as the tender assumed.
 *
 * The Commercial Director's centre reported "cash-flow model exists at bid
 * stage; no live forward cashflow", and the two are not the same document. The
 * S-curve is a bid assumption and stays one; peak funding is what closes
 * companies, and at month nine the record knows what has been certified and the
 * bid model still does not.
 *
 * Everything below turns on what is measured and what is not. A run rate comes
 * from certificates that exist or there is no run rate; money already certified
 * lands on a date the contract fixed rather than being averaged into a
 * projection; and the outflow side says out loud when nothing has been
 * certified down the chain, because a cumulative line built from inflow alone
 * is a useful number and a dangerous one.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const qs = (): EngineContext => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

describe('what has to be funded, measured from the record', () => {
  it('refuses to project where nothing has been certified, rather than falling back to the tender', () => {
    // The refusal that matters most. A bid assumption presented as a reading of
    // the record is the single most misleading thing this engine could do, and
    // the two are indistinguishable on screen once the label is gone.
    const empty = new Platform();
    const forward = cost.forwardCashflow({ ...qs(), ledger: empty.ledger, projectId: 'nothing' } as EngineContext);

    assert.equal(forward.derivable, false);
    assert.equal(forward.periods.length, 0);
    assert.match(String(forward.reason), /no upstream payment cycle/i);
  });

  it('takes the run rate from completed certifications, not from the contract sum', () => {
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    assert.equal(forward.derivable, true);

    const certificates = platform.ledger
      .list(seed.projectId, 'PaymentCertificate')
      .map((record) => Number(record.state.certifiedMinor ?? 0));

    assert.equal(forward.measuredFromCycles, certificates.length);
    assert.equal(
      forward.averageNetCertifiedMinor,
      Math.round(certificates.reduce((sum, value) => sum + value, 0) / certificates.length),
    );
  });

  it('lands a certified sum on its own final date, at its own value', () => {
    // The third certificate is certified short and outstanding. It is owed on a
    // date the contract already fixed, so it belongs to that period at that
    // figure — not averaged into a mean and not pulled forward to period one.
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    const unpaid = platform.ledger
      .list(seed.projectId, 'PaymentCertificate')
      .filter(
        (certificate) =>
          !platform.ledger
            .list(seed.projectId, 'LedgerEntry')
            .some((entry) => entry.state.type === 'PAYMENT' && entry.state.certificateId === certificate.refId),
      );

    const outstanding = unpaid.reduce((sum, certificate) => sum + Number(certificate.state.certifiedMinor ?? 0), 0);
    assert.ok(outstanding > 0, 'the seed no longer carries an unpaid certificate; this test proves nothing');
    assert.equal(forward.certifiedUnpaidMinor, outstanding);

    for (const certificate of unpaid) {
      const at = forward.periods.find(
        (period) => period.finalDateForPayment === String(certificate.state.finalDateForPayment),
      );
      assert.ok(at, 'a certified sum fell outside every period in the forecast');
      assert.equal(at.basis, 'CERTIFIED');
      assert.equal(at.inMinor, Number(certificate.state.certifiedMinor ?? 0));
    }
  });

  it('counts a period whose certificate is already paid as nil, not as another run-rate period', () => {
    // The seed pays ahead of its final dates, so periods one and two are settled
    // while their final dates are still in the future. Projecting the run rate
    // onto them as well would count the same valuation twice — a 12-period
    // forecast on this project overstated the closing position by £1bn until
    // this case existed.
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    const settled = forward.periods.filter((period) => period.basis === 'SETTLED');

    assert.ok(settled.length > 0, 'the seed no longer pays ahead of a final date; this test proves nothing');
    for (const period of settled) {
      assert.equal(period.inMinor, 0);
      const paid = platform.ledger
        .list(seed.projectId, 'PaymentCertificate')
        .find((certificate) => String(certificate.state.finalDateForPayment) === period.finalDateForPayment);
      assert.ok(paid, `period ${period.period} was called settled with no certificate against it`);
    }
  });

  it('projects the run rate only where nothing has been certified', () => {
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    const projected = forward.periods.filter((period) => period.basis === 'PROJECTED');
    assert.ok(projected.length > 0);
    for (const period of projected) {
      assert.ok(period.inMinor <= forward.averageNetCertifiedMinor);
    }
  });

  it('says the outflow side is unmeasured rather than spreading committed value across it', () => {
    // Nothing is certified down the chain on this project. Dividing the
    // subcontract commitments by the periods that remain would produce a
    // confident outgoing line that no certificate supports — a second bid model,
    // wearing the label of a measurement.
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    const committed = platform.ledger
      .list(seed.projectId, 'Commitment')
      .reduce((sum, record) => sum + Number(record.state.valueMinor ?? 0), 0);

    if (!forward.outflow.measured) {
      assert.equal(forward.outflow.averagePerPeriodMinor, 0);
      assert.equal(forward.outflow.measuredFromCertificates, 0);
      assert.match(String(forward.outflow.reason), /unmeasured/i);
      assert.match(forward.summary, /unmeasured/i);
      assert.ok(committed > 0, 'the seed carries no commitments; this test proves nothing');
      assert.ok(
        forward.periods.every((period) => period.outMinor === 0),
        'committed value was spread across the forecast without a certificate behind it',
      );
    }
  });

  it('starts at the next final date for payment, not at today', () => {
    // A period whose final date has passed is history. Including it would put
    // money that has already moved into a forecast of money that has not.
    const today = '2026-08-21';
    const forward = cost.forwardCashflow(qs(), today);
    for (const period of forward.periods) {
      assert.ok(period.finalDateForPayment > today, `period ${period.period} has already passed its final date`);
    }
  });

  it('reports the worst cumulative position, because that is the figure to fund', () => {
    // Peak funding, not the closing balance. A project that ends level having
    // been £2m down in March still had to find £2m in March, and the closing
    // number hides exactly the month that matters.
    const forward = cost.forwardCashflow(qs(), '2026-08-21');

    const lowest = forward.periods.reduce((low, period) => Math.min(low, period.cumulativeMinor), 0);
    assert.equal(forward.lowPointMinor, lowest);
    assert.equal(forward.closingMinor, forward.periods.at(-1)?.cumulativeMinor ?? 0);

    if (forward.lowPointMinor < 0) {
      const at = forward.periods.find((period) => period.cumulativeMinor === forward.lowPointMinor);
      assert.equal(forward.lowPointDate, at?.finalDateForPayment);
      assert.match(forward.summary, /worst on/i);
    } else {
      assert.equal(forward.lowPointDate, undefined);
    }
  });

  it('stops the run rate at the contract sum, and says which period it ran out at', () => {
    // A run rate cannot keep running past what is left to certify. Twelve
    // periods at the average produced a closing figure of £26.9m on a job worth
    // £20.5m — a confident number that could not happen. Where the rate runs out
    // early that is itself the finding: either the rate or the programme is
    // wrong, and the panel should say so rather than smoothing it.
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    assert.equal(forward.headroom.known, true);

    const certified = platform.ledger
      .list(seed.projectId, 'PaymentCertificate')
      .reduce((sum, record) => sum + Number(record.state.certifiedMinor ?? 0), 0);
    assert.equal(forward.headroom.certifiedToDateMinor, certified);
    assert.equal(
      forward.headroom.remainingCertifiableMinor,
      forward.headroom.contractValueMinor - forward.headroom.certifiedToDateMinor,
    );

    const projected = forward.periods
      .filter((period) => period.basis === 'PROJECTED')
      .reduce((sum, period) => sum + period.inMinor, 0);
    assert.ok(
      projected <= forward.headroom.remainingCertifiableMinor,
      'the forecast projects more income than the contract can still certify',
    );

    if (forward.headroom.exhaustsAtPeriod !== undefined) {
      assert.match(forward.summary, /exhausts what is left to certify/i);
      const after = forward.periods.filter(
        (period) => period.basis === 'PROJECTED' && period.period > forward.headroom.exhaustsAtPeriod!,
      );
      assert.ok(after.every((period) => period.inMinor === 0), 'income was projected past the contract sum');
    }
  });

  it('says the projection is uncapped where no executed contract carries a sum', () => {
    // Honest rather than convenient. Without a contract sum there is no ceiling,
    // and a projection that quietly runs without one will overstate every
    // project approaching completion.
    const bare = new Platform();
    const forward = cost.forwardCashflow({ ...qs(), ledger: bare.ledger, projectId: 'nothing' } as EngineContext);
    assert.equal(forward.headroom.known, false);
    assert.match(String(forward.headroom.reason), /no ceiling on the projection/i);
  });

  it('keeps the cumulative line internally consistent period by period', () => {
    const forward = cost.forwardCashflow(qs(), '2026-08-21');
    let running = 0;
    for (const period of forward.periods) {
      assert.equal(period.netMinor, period.inMinor - period.outMinor);
      running += period.netMinor;
      assert.equal(period.cumulativeMinor, running);
    }
  });

  it('separates money coming in from money going out by the direction of the cycle', () => {
    // A payment entry records no direction of its own. The only honest route is
    // certificate → application → cycle, and a downstream certificate is an
    // outgoing debt however similar the record looks.
    const ctx = qs();
    const contract = platform.ledger.list(seed.projectId, 'Subcontract')[0];
    if (!contract) return;

    const before = cost.forwardCashflow(qs(), '2026-08-21');

    const downstream = cost.generatePaymentSchedule(ctx, {
      contractId: contract.refId,
      startDate: '2026-07-01',
      cycles: 6,
      direction: 'DOWNSTREAM',
      terms: { applicationDayOfMonth: 25, paymentNoticeDays: 5, payLessNoticeDaysBeforeFinal: 7, finalDateDays: 30 },
    });
    const application = cost.submitApplication(ctx, {
      cycleId: downstream.cycleId,
      cycleNumber: 1,
      grossValuationMinor: 40_000_000,
      variationsIncludedMinor: 0,
      previouslyCertifiedMinor: 0,
      retentionMinor: 1_200_000,
      supportingEvidenceHash: hashEvidence('subcontract-application-1'),
    });
    cost.certifyApplication(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
      applicationId: application.applicationId,
      certifiedMinor: application.netAppliedMinor,
      retentionMinor: 1_200_000,
      issuedDate: '2026-07-30',
      certificateHash: hashEvidence('subcontract-certificate-1'),
    });

    const after = cost.forwardCashflow(qs(), '2026-08-21');

    // The downstream certificate must not have moved the receivable side at all.
    assert.equal(after.measuredFromCycles, before.measuredFromCycles);
    assert.equal(after.averageNetCertifiedMinor, before.averageNetCertifiedMinor);
    assert.equal(after.certifiedUnpaidMinor, before.certifiedUnpaidMinor);

    // And it must have made the outflow side measured, at its own value.
    assert.equal(after.outflow.measured, true);
    assert.equal(after.outflow.measuredFromCertificates, 1);
    assert.equal(after.outflow.certifiedUnpaidMinor, application.netAppliedMinor);
    assert.equal(after.outflow.averagePerPeriodMinor, application.netAppliedMinor);

    // And it must land as an outgoing on the period its own final date falls in,
    // not on whichever main-contract period happens to share its number.
    const at = after.periods.find((period) => period.outMinor === application.netAppliedMinor);
    assert.ok(at, 'a certified subcontract debt did not appear as an outgoing anywhere');
    assert.ok(
      after.closingMinor < before.closingMinor,
      'money going out did not reduce the position it has to be paid from',
    );
  });
});
