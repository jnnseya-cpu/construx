import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as retention from '../src/domain/retention.ts';
import * as pc from '../src/domain/practicalcompletion.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * Retention, and getting it back.
 *
 * The platform has always withheld it — every certificate carries a retention
 * figure and the commercial position sums them — and there was no way to ever
 * recover it. That is 3 to 5% of the contract sum: cash the contractor has
 * already earned and funded, whose second half is often years away, and which
 * for a small business is frequently the difference between the job having been
 * worth doing and not.
 */

async function contract(over: { retentionPercent?: number; defectsLiabilityMonths?: number } = {}) {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  const ctx = () => platform.context(seed.users.qs!.auth, seed.projectId);
  const approver = () => platform.context(seed.users.owner!.auth, seed.projectId);

  const existing = platform.ledger.list(seed.projectId, 'Contract')[0]!;
  return { platform, seed, ctx, approver, contractId: existing.refId, over };
}

/** What the demo seed already withheld across its certificates. */
function heldOn(platform: Platform, projectId: string): number {
  return platform.ledger
    .list(projectId, 'PaymentCertificate')
    .reduce((sum, record) => sum + Number(record.state.retentionMinor ?? 0), 0);
}

describe('what is held and what has fallen due', () => {
  it('counts what was actually withheld, not a percentage of the contract sum', async () => {
    // The two differ the moment the final account differs from the contract,
    // which is most of the time. Taking the percentage would release money that
    // was never held, or leave money behind that was.
    const c = await contract();
    const position = retention.retentionPosition(c.ctx(), c.contractId);
    assert.equal(position.heldMinor, heldOn(c.platform, c.seed.projectId));
    assert.ok(position.heldMinor > 0, 'the demo project withheld nothing to test against');
  });

  it('splits it in two halves', async () => {
    const c = await contract();
    const position = retention.retentionPosition(c.ctx(), c.contractId);
    assert.deepEqual(position.tranches.map((t) => t.sharePercent), [50, 50]);
    assert.equal(
      position.tranches.reduce((sum, t) => sum + t.entitlementMinor, 0),
      position.heldMinor,
    );
  });

  it('releases nothing while practical completion is uncertified', async () => {
    // Both halves are blocked, not just the first: the defects clock is counted
    // from the completion date, so without one the second has no trigger either.
    const c = await contract();
    const position = retention.retentionPosition(c.ctx(), c.contractId);
    for (const tranche of position.tranches) {
      assert.equal(tranche.releasable, false);
      assert.match(tranche.blockedBy ?? '', /Practical completion has not been certified/);
    }
    assert.equal(position.overdueMinor, 0);
    assert.match(position.summary, /Nothing falls due until practical completion is certified/);
  });
});

describe('once the job is complete', () => {
  /**
   * Certify completion through the real command, so the record this reads is
   * the record the platform actually writes — evidence, authority and all.
   * Hand-committing the event would test a shape nothing produces.
   */
  /**
   * Certifying completion is gated on the contract's clause register having had
   * legal review — a real governance control, because the register is written
   * by a model reading the contract and a defects period nobody checked is not
   * a date to start a liability running from. The gate is satisfied here rather
   * than worked around.
   */
  function validateClauses(c: Awaited<ReturnType<typeof contract>>) {
    for (const record of c.platform.ledger.list(c.seed.projectId, 'ContractClause')) {
      pc.validateContractClause(c.approver(), record.refId, {
        agrees: true,
        note: 'Checked against the executed contract; the period and reference are as extracted.',
        validatedBy: 'A. Reviewer',
      });
    }
  }

  async function completed(kind: 'PRACTICAL' | 'SECTIONAL' = 'PRACTICAL', completionDate = '2026-06-30') {
    const c = await contract();
    validateClauses(c);
    pc.issueCompletionCertificate(c.approver(), {
      reference: `PC-${kind}`,
      kind,
      ...(kind === 'SECTIONAL' ? { sectionReference: 'Section 1 — the car park' } : {}),
      scopeBoundary: 'The whole of the works described in the contract, excluding nothing.',
      completionDate,
      authority: 'Contract administrator under clause 2.30',
      decidedBy: 'A. Administrator',
      evidenceHash: hashEvidence(`completion-${kind}-${completionDate}`),
      // Every date the certificate is capable of setting. The command refuses a
      // partial certificate — "one nobody can answer questions about" — and the
      // two retention dates are the ones this module reads.
      periods: [
        { key: 'POSSESSION', periodDays: 0, ruleSource: 'Clause 2.30' },
        { key: 'INSURANCE_TRANSFER', periodDays: 0, ruleSource: 'Clause 6.8' },
        { key: 'LIQUIDATED_DAMAGES_END', periodDays: 0, ruleSource: 'Clause 2.32' },
        { key: 'DEFECTS_PERIOD_END', periodDays: 365, ruleSource: 'Clause 2.38' },
        { key: 'RETENTION_FIRST_RELEASE', periodDays: 0, ruleSource: 'Clause 4.20.1' },
        { key: 'RETENTION_FINAL_RELEASE', periodDays: 365, ruleSource: 'Clause 4.20.2' },
      ],
    });
    return c;
  }

  it('lets the first half go and holds the second', async () => {
    // Complete 30 June with a twelve-month defects period, asked on 1 July:
    // the first half has fallen due, the second runs to 30 June 2027.
    const c = await completed();
    const position = retention.retentionPosition(c.ctx(), c.contractId, '2026-07-01');

    const first = position.tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!;
    const second = position.tranches.find((t) => t.tranche === 'DEFECTS_EXPIRY')!;
    assert.equal(first.releasable, true);
    assert.equal(first.dueOn, '2026-06-30');
    assert.equal(second.releasable, false);
    assert.equal(second.dueOn, '2027-06-30');
    assert.match(second.blockedBy ?? '', /balance falls due on 2027-06-30, under Clause 4\.20\.2/);

    // And the first half is money sitting unclaimed, which is the number this
    // module exists to put in front of somebody.
    assert.equal(position.overdueMinor, first.entitlementMinor);
    assert.match(position.summary, /has fallen due and is unclaimed/);
  });

  it('refuses to release the second half early', async () => {
    const c = await completed();
    throwsCode(
      () =>
        retention.releaseRetention(c.approver(), {
          contractId: c.contractId,
          tranche: 'DEFECTS_EXPIRY',
          amountMinor: 1_00,
          releasedOn: '2026-07-01',
        }),
      'RETENTION_NOT_DUE',
    );
  });

  it('releases the first half, and then knows it is gone', async () => {
    const c = await completed();
    const before = retention.retentionPosition(c.ctx(), c.contractId, '2026-07-01');
    const first = before.tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!;

    const released = retention.releaseRetention(c.approver(), {
      contractId: c.contractId,
      tranche: 'PRACTICAL_COMPLETION',
      amountMinor: first.entitlementMinor,
      releasedOn: '2026-07-01',
    });
    assert.equal(released.amountMinor, first.entitlementMinor);

    const after = retention.retentionPosition(c.ctx(), c.contractId, '2026-07-01');
    assert.equal(after.releasedMinor, first.entitlementMinor);
    assert.equal(after.outstandingMinor, before.heldMinor - first.entitlementMinor);
    assert.equal(after.overdueMinor, 0, 'a released tranche is still being reported as unclaimed');
    assert.equal(after.tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!.releasable, false);
  });

  it('refuses to release more than the tranche holds', async () => {
    const c = await completed();
    const first = retention
      .retentionPosition(c.ctx(), c.contractId, '2026-07-01')
      .tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!;
    throwsCode(
      () =>
        retention.releaseRetention(c.approver(), {
          contractId: c.contractId,
          tranche: 'PRACTICAL_COMPLETION',
          amountMinor: first.entitlementMinor + 1,
          releasedOn: '2026-07-01',
        }),
      'RETENTION_OVER_RELEASE',
    );
  });

  it('refuses a second release that would take the tranche over', async () => {
    // Half now, and then more than the other half. The first release must
    // reduce what the second is measured against, or a tranche can be drained
    // twice in instalments.
    const c = await completed();
    const first = retention
      .retentionPosition(c.ctx(), c.contractId, '2026-07-01')
      .tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!;
    const half = Math.floor(first.entitlementMinor / 2);

    retention.releaseRetention(c.approver(), {
      contractId: c.contractId,
      tranche: 'PRACTICAL_COMPLETION',
      amountMinor: half,
      releasedOn: '2026-07-01',
    });
    throwsCode(
      () =>
        retention.releaseRetention(c.approver(), {
          contractId: c.contractId,
          tranche: 'PRACTICAL_COMPLETION',
          amountMinor: first.entitlementMinor - half + 1,
          releasedOn: '2026-07-02',
        }),
      'RETENTION_OVER_RELEASE',
    );
  });

  it('releases the second half once the defects period has run', async () => {
    const c = await completed();
    const position = retention.retentionPosition(c.ctx(), c.contractId, '2027-07-01');
    const second = position.tranches.find((t) => t.tranche === 'DEFECTS_EXPIRY')!;
    assert.equal(second.releasable, true);
    // Both halves unclaimed a year on, which is exactly how retention is lost.
    assert.equal(position.overdueMinor, position.heldMinor);
  });

  it('quotes the clause each date came from', async () => {
    // The date is the certificate's, derived from the validated clause
    // register, and the clause travels with it. "It falls due on the 30th"
    // is an assertion; "it falls due on the 30th under clause 4.20.1" is a
    // position somebody can check.
    const c = await completed();
    const position = retention.retentionPosition(c.ctx(), c.contractId, '2026-07-01');
    assert.equal(position.tranches.find((t) => t.tranche === 'PRACTICAL_COMPLETION')!.ruleSource, 'Clause 4.20.1');
    assert.equal(position.tranches.find((t) => t.tranche === 'DEFECTS_EXPIRY')!.ruleSource, 'Clause 4.20.2');
  });

  it('does not start the clock on a sectional completion', async () => {
    // A car park handed over early is not the contract complete. Taking it
    // would release the last half of the retention on the strength of it.
    const c = await completed('SECTIONAL', '2026-01-01');
    const position = retention.retentionPosition(c.ctx(), c.contractId, '2026-07-01');
    assert.equal(position.completionDate, undefined);
    assert.equal(position.tranches.every((t) => !t.releasable), true);
  });
});

describe('pay when paid', () => {
  it('reports the clause as ineffective rather than as a risk to price', async () => {
    // Section 113 of the Construction Act. The expensive mistake is not
    // signing the clause — it is void either way — it is pricing a cash risk
    // the contractor does not carry, while the competitor who read the Act
    // does not price it.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const ctx = platform.context(seed.users.qs!.auth, seed.projectId);
    const { analyseITT } = await import('../src/domain/itt.ts');

    const result = analyseITT(ctx, {
      reference: 'ITT-PWP',
      clientName: 'A Buyer With A Precedent Bank',
      returnBy: '2026-09-30',
      estimatedValueMinor: 2_000_000_00,
      durationWeeks: 40,
      requirements: [
        {
          reference: 'R1',
          category: 'TECHNICAL',
          requirement: 'Method statement for the works',
          mandatory: false,
          evidenceRequired: 'A method statement',
        },
      ],
      terms: { contractForm: 'BESPOKE', paymentConditionalOnThirdParty: true },
    });

    const term = result.terms.find((t) => t.term === 'Payment conditional on the buyer being paid');
    assert.ok(term, 'a pay-when-paid clause was carried without being assessed');
    assert.match(term.assessment, /Ineffective under section 113/);
    assert.match(term.assessment, /except where the third party is insolvent/);
    assert.match(term.assessment, /not a cash risk to price for/);

    // Not a bar: the clause is void, so it does not stop the bid.
    assert.equal(result.bars.includes('Payment conditional on the buyer being paid'), false);
    assert.ok(result.clarifications.some((c) => /section 113/i.test(c)));
  });

  it('says nothing about it where the clause is absent', async () => {
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const ctx = platform.context(seed.users.qs!.auth, seed.projectId);
    const { analyseITT } = await import('../src/domain/itt.ts');
    const result = analyseITT(ctx, {
      reference: 'ITT-CLEAN',
      clientName: 'An Ordinary Buyer',
      returnBy: '2026-09-30',
      estimatedValueMinor: 2_000_000_00,
      durationWeeks: 40,
      requirements: [
        {
          reference: 'R1',
          category: 'TECHNICAL',
          requirement: 'Method statement for the works',
          mandatory: false,
          evidenceRequired: 'A method statement',
        },
      ],
      terms: { contractForm: 'NEC4' },
    });
    assert.equal(result.terms.some((t) => /conditional on the buyer/.test(t.term)), false);
  });
});
