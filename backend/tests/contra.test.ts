import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { contraPosition, ledgerPosition, raiseContraCharge } from '../src/engines/cost.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * Contra charges, and the notice that decides whether they are money.
 *
 * The charge is usually justified. Contractors lose this argument on the
 * notice, not on the merits: under the Construction Act a payer may not pay
 * less than the notified sum without a valid pay less notice given in time, so
 * a contra raised without one is not a deduction — it is an intention to
 * deduct, handed back at adjudication and then chased separately.
 *
 * A commercial forecast that counts an unnotified set-off as recovered is
 * wrong by exactly the amount that matters.
 */

let platform: Platform;
let seed: SeedResult;
let subcontractId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  subcontractId = platform.ledger.list(seed.projectId, 'Subcontract')[0]!.refId;
});

const qs = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const charge = (over: Partial<Parameters<typeof raiseContraCharge>[1]> = {}) =>
  raiseContraCharge(qs(), {
    subcontractId,
    reason: 'CLEANING_AND_WASTE',
    amountMinor: 240_000,
    narrative: 'Skips and labour to clear level 2 after the trade left site',
    incurredOn: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
    evidenceHash: `sha256:${'a'.repeat(64)}`,
    ...over,
  });

describe('raising a contra charge', () => {
  it('records it, and computes whether it is enforceable rather than being told', () => {
    // A field the caller could set is a field the caller sets to true.
    const result = charge();
    assert.ok(result.reference.startsWith('CON-'));
    assert.equal(result.enforceable, false);
    assert.match(result.reason ?? '', /pay less notice/i);
  });

  it('records an unnotified charge rather than refusing it', () => {
    // Refusing would destroy the evidence of the cost, which is the thing
    // needed to recover it by the route that remains open.
    const before = contraPosition(qs()).raisedMinor;
    charge({ amountMinor: 150_000 });
    assert.equal(contraPosition(qs()).raisedMinor, before + 150_000);
  });

  it('refuses a cost that has not been incurred yet', () => {
    // Dated in the future it is a forecast, and a forecast is not a set-off.
    // VALIDATION_FAILED rather than a bespoke code, so the refusal arrives as
    // problem+json against the `incurredOn` field and the form marks the box
    // the person got wrong instead of showing a banner.
    throwsCode(
      () => charge({ incurredOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }),
      'VALIDATION_FAILED',
    );
  });

  it('refuses a zero or negative amount', () => {
    throwsCode(() => charge({ amountMinor: 0 }), 'CONTRA_AMOUNT_INVALID');
    throwsCode(() => charge({ amountMinor: -5_000 }), 'CONTRA_AMOUNT_INVALID');
  });

  it('will not be given effect by a notice that does not exist', () => {
    const result = charge({ payLessNoticeId: 'not-a-notice' });
    assert.equal(result.enforceable, false);
    assert.match(result.reason ?? '', /does not exist/i);
  });
});

describe('the contra position', () => {
  it('separates what was charged from what will stand', () => {
    // £180,000 charged reads as £180,000 recovered. If £140,000 of it was
    // raised without a notice, £40,000 was recovered and the rest is a debt
    // claim. Those are different positions and only one is in the forecast.
    const position = contraPosition(qs());
    assert.equal(position.atRiskMinor, position.raisedMinor - position.enforceableMinor);
    assert.ok(position.raisedMinor > 0, 'nothing was charged');
    assert.ok(position.atRiskMinor > 0, 'every unnotified charge was treated as enforceable');
  });

  it('groups by subcontract and states the barrier on each charge', () => {
    for (const group of contraPosition(qs()).bySupplier) {
      assert.ok(group.subcontractId.length > 0);
      assert.equal(
        group.raisedMinor,
        group.charges.reduce((sum, c) => sum + c.amountMinor, 0),
        'a group total disagrees with its charges',
      );
      for (const c of group.charges) {
        if (!c.enforceable) assert.ok(c.barrier, 'a charge that will not stand does not say why');
      }
    }
  });

  it('puts the most at risk first', () => {
    const groups = contraPosition(qs()).bySupplier;
    for (let i = 1; i < groups.length; i += 1) {
      const previous = groups[i - 1]!.raisedMinor - groups[i - 1]!.enforceableMinor;
      const current = groups[i]!.raisedMinor - groups[i]!.enforceableMinor;
      assert.ok(previous >= current, 'the money that will not stand is not the top of the list');
    }
  });
});

describe('the commercial ledger sees it', () => {
  it('raises an exception for every set-off with no effective notice', () => {
    const position = ledgerPosition(qs());
    const unnotified = position.exceptions.filter((e) => e.type === 'UNNOTIFIED_SET_OFF');
    assert.ok(unnotified.length > 0, 'the ledger reports no unnotified set-off');
    for (const exception of unnotified) assert.ok(exception.detail.length > 0);
  });

  it('carries both figures, so a forecast cannot quietly use the wrong one', () => {
    const position = ledgerPosition(qs());
    assert.ok(position.contraChargedMinor >= position.contraEnforceableMinor);
    assert.equal(position.contraChargedMinor, contraPosition(qs()).raisedMinor);
  });
});
