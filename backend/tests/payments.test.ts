import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as cost from '../src/engines/cost.ts';
import { scopesForRoles } from '../src/identity/scopes.ts';
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

  it('refuses to let the person who applied certify their own application', async () => {
    // This function's own comment has always said certification "is separated
    // from whoever submitted the application". It was not: the application
    // recorded `submittedBy` and certification never read it, so one identity
    // could apply for a payment and turn it into a debt with nobody else in
    // the loop.
    //
    // The permission matrix does not close this. Separation between *roles* is
    // not separation between *people*, and a small business stacks roles on one
    // person as a matter of course — which is exactly the business this
    // platform is built for, and exactly why the control has to be on the
    // identity rather than on the role.
    //
    // Its own platform, because this test certifies an application and the
    // suite around it counts certificates.
    const own = new Platform();
    const ownSeed = await seedDemoProject(own);

    // One identity holding both roles, which is the case that was open. A plain
    // QS is already stopped by the permission matrix — it has no approve verb
    // on payment applications — so testing that would prove only that RBAC
    // works. What RBAC cannot see is the same *person* holding both.
    const roles = [...new Set([...ownSeed.users.qs!.auth.roles, ...ownSeed.users.owner!.auth.roles])];
    const stacked = { ...ownSeed.users.qs!.auth, roles, scopes: scopesForRoles(roles) };
    const both = () => own.context(stacked, ownSeed.projectId);

    const cycle = own.ledger.list(ownSeed.projectId, 'PaymentCycle')[0]!;
    const mine = cost.submitApplication(both(), {
      cycleId: cycle.refId,
      cycleNumber: 5,
      grossValuationMinor: 100_000_000,
      variationsIncludedMinor: 0,
      previouslyCertifiedMinor: 0,
      retentionMinor: 0,
      supportingEvidenceHash: hashEvidence('self-cert-application'),
    });

    throwsCode(
      () =>
        // The same identity that submitted it, now wearing the certifying role
        // as well. Nothing in the permission matrix objects — and until this
        // control existed, nothing else did either.
        cost.certifyApplication(both(), {
          applicationId: mine.applicationId,
          certifiedMinor: mine.netAppliedMinor,
          retentionMinor: 0,
          issuedDate: '2026-12-01',
          certificateHash: hashEvidence('self-certificate'),
        }),
      'CERTIFICATION_SELF_APPROVAL',
    );

    // And a second party certifies it perfectly well, so the control blocks the
    // one case rather than the command.
    const certificate = cost.certifyApplication(own.context(ownSeed.users.owner!.auth, ownSeed.projectId), {
      applicationId: mine.applicationId,
      certifiedMinor: mine.netAppliedMinor,
      retentionMinor: 0,
      issuedDate: '2026-12-01',
      certificateHash: hashEvidence('second-party-certificate'),
    });
    assert.equal(certificate.certifiedMinor, mine.netAppliedMinor);
  });

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
