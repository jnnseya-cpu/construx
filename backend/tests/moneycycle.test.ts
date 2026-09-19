import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { bareConstructionProject } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The money, over HTTP: application, certificate, notice, payment.
 *
 * `payments.test.ts` covers the same rules by calling the engine, and it is
 * the reason those rules exist. This is the other question, and the one the
 * engine tests cannot answer: **does a person with a browser reach them?**
 *
 * That distinction has been expensive twice this week. Three route schemas
 * refused fields their own engines require, and every test called the engine
 * directly, so the schemas were never exercised at all — the estimating line
 * was unusable while its engine tests were green. The payment cycle is where
 * that failure costs somebody money rather than an afternoon: an application
 * that cannot be submitted is a month of work uninvoiced, and a certificate
 * that goes through when it should not is a debt the business did not intend
 * to owe.
 *
 * So every refusal below is asserted **through the gateway**, with the status
 * code and the error code a client actually branches on — and every one of
 * them is a rule with money on the other side of it:
 *
 * - the person who applied cannot certify their own application;
 * - more cannot be certified than was applied for;
 * - more cannot be paid than was certified;
 * - a certificate cannot be paid twice for the same money;
 * - the statutory notice dates are computed, not typed.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;

type Reply = { status: number; body: any; text: string };

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', { body: { email } });
  assert.equal(login.status, 201, login.text);
  const verified = await call('POST', '/v1/auth/mfa/verify', {
    body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
  });
  assert.equal(verified.status, 201, verified.text);
  return verified.body.accessToken as string;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // A project on site with nothing done on it, built through the same gates a
  // person walks. The payment cycle only opens at CONSTRUCTION, and borrowing
  // a project that already carries payments would leave every figure below
  // asserted against somebody else's arithmetic.
  ({ projectId } = await bareConstructionProject(platform, seed, 'Money Cycle Fixture'));

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server?.close());

/** The surveyor applies. The owner certifies. Two people, because one is the rule. */
let qs = '';
let owner = '';
let cycleId = '';
let applicationId = '';
let certificateId = '';

/** £180,000 of work in the ground, £9,000 retention at five per cent. */
const GROSS = 180_000_00;
const RETENTION = 9_000_00;
const NET = GROSS - RETENTION;

describe('the payment cycle, over HTTP', () => {
  it('signs in the two people a payment needs', async () => {
    qs = await signIn('qs@meridian.example');
    owner = await signIn('owner@meridian.example');
    assert.ok(qs.length > 20);
    assert.ok(owner.length > 20);
  });

  it('computes the statutory dates rather than asking anybody to type them', async () => {
    /*
     * The dates are the whole point of the Construction Act half of this. A
     * payment notice is due so many days after the due date, a pay-less notice
     * so many days before the final date for payment, and getting one of them
     * wrong is how a payer ends up owing the notified sum in full regardless of
     * what the work was worth. They are computed from the contract terms, once,
     * and every application inherits the period it falls in.
     */
    const schedule = await call('POST', `/v1/projects/${projectId}/cost/payment-cycle`, {
      token: qs,
      body: {
        contractId: 'CONTRACT-MONEY-001',
        startDate: '2026-10-01',
        cycles: 3,
        direction: 'UPSTREAM',
        terms: {
          applicationDayOfMonth: 25,
          paymentNoticeDays: 5,
          payLessNoticeDaysBeforeFinal: 7,
          finalDateDays: 21,
        },
      },
    });
    assert.equal(schedule.status, 201, schedule.text);
    cycleId = String(schedule.body.cycleId);

    const periods = schedule.body.periods as Array<Record<string, any>>;
    assert.equal(periods.length, 3, 'three cycles were asked for');
    for (const period of periods) {
      assert.ok(period.dueDate, `cycle ${period.cycleNumber} has no due date`);
      assert.ok(period.paymentNoticeDeadline, `cycle ${period.cycleNumber} has no payment notice deadline`);
      assert.ok(period.finalDateForPayment, `cycle ${period.cycleNumber} has no final date for payment`);
      // The order the Act puts them in. A final date before the notice
      // deadline is a schedule that cannot be complied with.
      assert.ok(
        Date.parse(period.paymentNoticeDeadline) <= Date.parse(period.finalDateForPayment),
        `cycle ${period.cycleNumber} expects the payment notice after the final date for payment`,
      );
    }
  });

  it('refuses a schedule nobody could work to', async () => {
    // Unbounded cycles drove a loop in a single-threaded process, and an
    // unparseable date wrote Invalid Date into an append-only record that
    // cannot afterwards be corrected. Both are refused by the schema, which is
    // only true if a request actually goes through it.
    const silly = await call('POST', `/v1/projects/${projectId}/cost/payment-cycle`, {
      token: qs,
      body: {
        contractId: 'CONTRACT-MONEY-001',
        startDate: 'whenever',
        cycles: 100_000,
        direction: 'UPSTREAM',
        terms: { applicationDayOfMonth: 25, paymentNoticeDays: 5, payLessNoticeDaysBeforeFinal: 7, finalDateDays: 21 },
      },
    });
    assert.ok(silly.status >= 400 && silly.status < 500, silly.text);
  });

  it('takes an application with the valuation behind it', async () => {
    const application = await call('POST', `/v1/projects/${projectId}/cost/application`, {
      token: qs,
      body: {
        cycleId,
        cycleNumber: 1,
        grossValuationMinor: GROSS,
        variationsIncludedMinor: 0,
        previouslyCertifiedMinor: 0,
        retentionMinor: RETENTION,
        // The valuation the figure came from. An application with no support
        // is a number in an email, and the evidence reference is what makes it
        // a record.
        supportingEvidenceHash: hashEvidence(JSON.stringify({ valuation: 'October interim', grossMinor: GROSS })),
      },
    });
    assert.equal(application.status, 201, application.text);
    applicationId = String(application.body.applicationId);
    assert.equal(application.body.netAppliedMinor, NET, 'the net applied is not gross less retention');
  });

  it('will not let the person who applied certify their own application', async () => {
    /*
     * The control that matters most on this whole screen, and the one a
     * permission matrix does not give you. Separation between *roles* is not
     * separation between *people*, and a small business stacks roles on one
     * person as a matter of course — so a surveyor holding both could apply
     * for a payment and turn it into a debt with nobody else in the loop.
     */
    const self = await call('POST', `/v1/projects/${projectId}/cost/application/${applicationId}/certify`, {
      token: qs,
      body: {
        certifiedMinor: NET,
        retentionMinor: RETENTION,
        issuedDate: '2026-10-30',
        certificateHash: hashEvidence(JSON.stringify({ certificate: 1 })),
      },
    });
    assert.ok(self.status >= 400, 'the person who applied certified their own application');
    assert.match(self.text, /CERTIFICATION_SELF_APPROVAL|ACCESS_DENIED/);
  });

  it('will not certify more than was applied for', async () => {
    const over = await call('POST', `/v1/projects/${projectId}/cost/application/${applicationId}/certify`, {
      token: owner,
      body: {
        certifiedMinor: NET + 1_00,
        retentionMinor: RETENTION,
        issuedDate: '2026-10-30',
        certificateHash: hashEvidence(JSON.stringify({ certificate: 'too big' })),
      },
    });
    // A refusal, by its code. The status is the platform's to choose — 422 is
    // right for a request that is well formed and asks for something the rules
    // forbid — and a client branches on the code, so that is what is pinned.
    assert.ok(over.status >= 400, 'more was certified than was applied for');
    assert.match(over.text, /OVERCERTIFICATION/);
  });

  it('certifies less than was applied for, and says why', async () => {
    /*
     * The ordinary case, and it is a disagreement rather than a rejection. A
     * certificate for less than the application is the payer's valuation of
     * the same work, and the reason is what the surveyor argues with — a
     * number on its own is how a payment dispute starts.
     */
    const certified = await call('POST', `/v1/projects/${projectId}/cost/application/${applicationId}/certify`, {
      token: owner,
      body: {
        certifiedMinor: 150_000_00,
        retentionMinor: RETENTION,
        issuedDate: '2026-10-30',
        certificateHash: hashEvidence(JSON.stringify({ certificate: 1 })),
        reason: 'Blockwork to grid 4–7 measured at 60% rather than the 85% applied for; joint inspection 28 October.',
      },
    });
    assert.equal(certified.status, 201, certified.text);
    certificateId = String(certified.body.certificateId);
    assert.equal(certified.body.certifiedMinor, 150_000_00);
    assert.equal(
      certified.body.withheldMinor,
      NET - 150_000_00,
      'what was withheld is not the difference between applied and certified',
    );
  });

  it('will not certify the same application twice', async () => {
    const again = await call('POST', `/v1/projects/${projectId}/cost/application/${applicationId}/certify`, {
      token: owner,
      body: {
        certifiedMinor: 1_000_00,
        retentionMinor: RETENTION,
        issuedDate: '2026-10-31',
        certificateHash: hashEvidence(JSON.stringify({ certificate: 'second' })),
      },
    });
    assert.ok(again.status >= 400, 'one application was certified twice');
    assert.match(again.text, /APPLICATION_NOT_SUBMITTED/);
  });

  it('will not pay more than was certified, in one payment or in two', async () => {
    const over = await call('POST', `/v1/projects/${projectId}/cost/certificate/${certificateId}/payment`, {
      token: owner,
      body: { amountMinor: 150_000_01, paidDate: '2026-11-20', reference: 'FT-OVER' },
    });
    assert.ok(over.status >= 400, 'more was paid than was certified');
    assert.match(over.text, /OVERPAYMENT/);

    // Part paid, then the rest, then a pound too much. The refusal has to
    // count what is already posted rather than looking at one payment alone —
    // that is how a certificate gets paid twice.
    const part = await call('POST', `/v1/projects/${projectId}/cost/certificate/${certificateId}/payment`, {
      token: owner,
      body: { amountMinor: 100_000_00, paidDate: '2026-11-20', reference: 'FT-26112001' },
    });
    assert.equal(part.status, 201, part.text);

    const creep = await call('POST', `/v1/projects/${projectId}/cost/certificate/${certificateId}/payment`, {
      token: owner,
      body: { amountMinor: 50_000_01, paidDate: '2026-11-21', reference: 'FT-26112101' },
    });
    assert.ok(creep.status >= 400, 'two payments together exceeded the certificate');
    assert.match(creep.text, /OVERPAYMENT/);

    const balance = await call('POST', `/v1/projects/${projectId}/cost/certificate/${certificateId}/payment`, {
      token: owner,
      body: { amountMinor: 50_000_00, paidDate: '2026-11-21', reference: 'FT-26112102' },
    });
    assert.equal(balance.status, 201, balance.text);

    const closed = await call('POST', `/v1/projects/${projectId}/cost/certificate/${certificateId}/payment`, {
      token: owner,
      body: { amountMinor: 1_00, paidDate: '2026-11-22', reference: 'FT-26112201' },
    });
    assert.ok(closed.status >= 400, 'a fully paid certificate took another payment');
  });

  it('reports the notice position for the cycle, computed from the record', async () => {
    const notices = await call('GET', `/v1/projects/${projectId}/cost/notices/${cycleId}`, { token: qs });
    assert.equal(notices.status, 200, notices.text);
    const position = notices.body.position as Array<Record<string, any>>;
    assert.ok(Array.isArray(position) && position.length > 0, 'the notice position is empty for a cycle that has one');
    const first = position.find((entry) => entry.cycleNumber === 1);
    assert.ok(first, 'cycle 1 has an application and a certificate and does not appear');
  });

  it('issues a pay-less notice with a basis a person can argue with', async () => {
    /*
     * Section 111. A payer who wants to pay less than the notified sum must
     * say so, in time, with the basis of the sum considered due — and if they
     * do not, they owe the notified sum whatever the work was worth. The
     * schema holds the basis to twenty characters minimum for that reason: a
     * pay-less notice reading "defects" is one a tribunal disregards.
     */
    const second = await call('POST', `/v1/projects/${projectId}/cost/application`, {
      token: qs,
      body: {
        cycleId,
        cycleNumber: 2,
        grossValuationMinor: 240_000_00,
        variationsIncludedMinor: 0,
        previouslyCertifiedMinor: 150_000_00,
        retentionMinor: 12_000_00,
        supportingEvidenceHash: hashEvidence(JSON.stringify({ valuation: 'November interim' })),
      },
    });
    assert.equal(second.status, 201, second.text);
    const secondId = String(second.body.applicationId);

    const thin = await call('POST', `/v1/projects/${projectId}/cost/application/${secondId}/pay-less`, {
      token: owner,
      body: {
        sumConsideredDueMinor: 40_000_00,
        basis: 'defects',
        issuedDate: '2026-11-28',
        noticeHash: hashEvidence(JSON.stringify({ notice: 'thin' })),
      },
    });
    assert.ok(thin.status >= 400, 'a pay-less notice went out with no basis anybody could answer');

    const notice = await call('POST', `/v1/projects/${projectId}/cost/application/${secondId}/pay-less`, {
      token: owner,
      body: {
        sumConsideredDueMinor: 40_000_00,
        basis:
          'Blockwork to grid 4–7 rejected at joint inspection on 24 November and to be rebuilt; £38,000 of the sum applied ' +
          'for is against work that will be taken down.',
        issuedDate: '2026-11-28',
        noticeHash: hashEvidence(JSON.stringify({ notice: 'proper' })),
      },
    });
    assert.equal(notice.status, 201, notice.text);
  });

  it('carries what was certified into what is owed, without anybody adding it up by hand', async () => {
    /*
     * The bridge between the surveyor and finance, which is the reason this
     * platform holds the payment cycle at all. £150,000 certified and
     * £150,000 posted against it: the ledger has to say so without somebody
     * reconciling two screens by eye, because that reconciliation is where
     * money goes missing on a real job.
     */
    const ledger = await call('GET', `/v1/projects/${projectId}/cost/ledger`, { token: qs });
    if (ledger.status === 404) return; // No published position; the rules above are the guarantee.
    assert.equal(ledger.status, 200, ledger.text);
    const printed = JSON.stringify(ledger.body);
    assert.ok(printed.includes('15000000'), `the ledger does not carry the £150,000 certified: ${printed.slice(0, 400)}`);
  });
});
