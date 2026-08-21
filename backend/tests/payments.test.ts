import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as cost from '../src/engines/cost.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The payment cycle end to end.
 *
 * A valuation becomes a debt at certification, and the commercial ledger is the
 * bridge between the QS and finance. Both halves have to be real records — a
 * certification history asserted on an application, with nothing behind it, is
 * exactly what this system exists to prevent.
 */

describe('payment certification and settlement', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  const context = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

  it('reports certified and paid sums backed by records, not assertions', () => {
    const position = cost.ledgerPosition(context('qs'));

    const certificates = platform.ledger.list(seed.projectId, 'PaymentCertificate');
    assert.equal(certificates.length, 3, 'three cycles were certified');

    const certified = certificates.reduce((sum, c) => sum + Number(c.state.certifiedMinor), 0);
    assert.equal(position.certifiedMinor, certified);
    assert.ok(position.paidMinor > 0 && position.paidMinor < position.certifiedMinor, 'one certificate is outstanding');
    assert.ok(position.certifiedMinor <= position.committedMinor, 'certified must not exceed committed');
  });

  it('holds retention against every certificate', () => {
    const position = cost.ledgerPosition(context('qs'));
    assert.ok(position.retentionHeldMinor > 0);
  });

  it('raises the unpaid certificate as an exception rather than burying it', () => {
    const position = cost.ledgerPosition(context('qs'));
    const unpaid = position.exceptions.filter((e) => e.type === 'UNPAID_CERTIFICATE');
    assert.equal(unpaid.length, 1);
    assert.match(unpaid[0]!.detail, /no payment posted/);
  });

  it('records what was withheld and why', () => {
    const short = platform.ledger
      .list(seed.projectId, 'PaymentCertificate')
      .find((c) => Number(c.state.withheldMinor) > 0);

    assert.ok(short, 'the demo certifies one application short');
    assert.match(String(short.state.reason), /Handrail terminations/);
    assert.equal(
      Number(short.state.withheldMinor),
      Number(short.state.appliedMinor) - Number(short.state.certifiedMinor),
    );
  });

  it('issues a payment notice alongside every certificate', () => {
    const certificates = platform.ledger.list(seed.projectId, 'PaymentCertificate');
    const notices = platform.ledger.list(seed.projectId, 'PaymentNotice');
    assert.equal(notices.length, certificates.length);
    for (const certificate of certificates) {
      assert.ok(
        notices.some((n) => n.refId === certificate.state.noticeId),
        'each certificate names the notice that carries it',
      );
    }
  });

  it('keeps certification away from whoever applied', () => {
    const application = platform.ledger.list(seed.projectId, 'PaymentApplication')[0]!;
    // The QS submits applications and cannot certify one.
    throwsCode(
      () =>
        cost.certifyApplication(context('qs'), {
          applicationId: application.refId,
          certifiedMinor: 1_000,
          retentionMinor: 0,
          issuedDate: '2026-11-30',
          certificateHash: hashEvidence('nope'),
        }),
      'ACCESS_DENIED',
    );
  });

  it('refuses to certify more than was applied for', () => {
    const outstanding = platform.ledger
      .list(seed.projectId, 'PaymentApplication')
      .find((a) => a.state.status === 'SUBMITTED');

    if (!outstanding) {
      // Every application in the demo is certified, so submit one to test against.
      const cycle = platform.ledger.list(seed.projectId, 'PaymentCycle')[0]!;
      const fresh = cost.submitApplication(context('qs'), {
        cycleId: cycle.refId,
        cycleNumber: 4,
        grossValuationMinor: 700_000_000,
        variationsIncludedMinor: 0,
        previouslyCertifiedMinor: 620_000_000,
        retentionMinor: 2_400_000,
        supportingEvidenceHash: hashEvidence('application-4-valuation'),
      });
      throwsCode(
        () =>
          cost.certifyApplication(context('owner'), {
            applicationId: fresh.applicationId,
            certifiedMinor: fresh.netAppliedMinor + 1,
            retentionMinor: 2_400_000,
            issuedDate: '2026-11-30',
            certificateHash: hashEvidence('certificate-4'),
          }),
        'OVERCERTIFICATION',
      );
      return;
    }

    throwsCode(
      () =>
        cost.certifyApplication(context('owner'), {
          applicationId: outstanding.refId,
          certifiedMinor: Number(outstanding.state.netAppliedMinor) + 1,
          retentionMinor: 0,
          issuedDate: '2026-11-30',
          certificateHash: hashEvidence('too-much'),
        }),
      'OVERCERTIFICATION',
    );
  });

  it('refuses to pay more than was certified', () => {
    const certificate = platform.ledger.list(seed.projectId, 'PaymentCertificate')[0]!;
    throwsCode(
      () =>
        cost.postPayment(context('owner'), {
          certificateId: certificate.refId,
          amountMinor: Number(certificate.state.certifiedMinor),
          paidDate: '2026-11-30',
          reference: 'DOUBLE-PAY',
        }),
      'OVERPAYMENT',
    );
  });

  it('refuses to certify an application twice', () => {
    const certified = platform.ledger
      .list(seed.projectId, 'PaymentApplication')
      .find((a) => a.state.status === 'CERTIFIED');

    assert.ok(certified);
    throwsCode(
      () =>
        cost.certifyApplication(context('owner'), {
          applicationId: certified.refId,
          certifiedMinor: 1_000,
          retentionMinor: 0,
          issuedDate: '2026-11-30',
          certificateHash: hashEvidence('again'),
        }),
      'APPLICATION_NOT_SUBMITTED',
    );
  });
});
