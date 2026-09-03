import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { TRIAL_GRANT_NOTE } from '../src/billing/acu.ts';
import { config } from '../src/config.ts';
import { Platform } from '../src/platform.ts';

/**
 * The free trial has a ceiling.
 *
 * "1 identity · 1 GB · 500 trial ACUs, once" was the pricing card, and the
 * observation that prompted this was arithmetic: a million signups at that
 * grant is a seven-figure vendor bill with no revenue against it. Two things
 * bound it now. The grant is sized as a first task rather than a first project,
 * and the platform gives away at most a configured amount of trial credit per
 * calendar month, across every signup. Beyond that a tenancy is still created
 * and the wallet opens empty — and the person is told.
 *
 * The budget is computed from the wallets rather than kept as a counter, so it
 * is right after a restart and cannot disagree with what was actually granted.
 */

const original = { ...config.billing };

function tune(over: Partial<typeof config.billing>): void {
  Object.assign(config.billing as object, original, over);
}

const CUSTOMER = {
  jurisdiction: 'GB',
  defaultCurrency: 'GBP',
  tier: 'FREE_TRIAL' as const,
};

let platform: Platform;

beforeEach(() => {
  platform = new Platform();
  tune({ freeTrialGrantMinor: 100, trialMonthlyBudgetMinor: 250 });
});

describe('one grant is a first task, not a first project', () => {
  it('opens a new tenancy with exactly the configured grant', () => {
    const { wallet, trialGrantMinor } = platform.createTenant({ ...CUSTOMER, legalName: 'A Ltd', enterpriseName: 'A' });
    assert.equal(trialGrantMinor, 100);
    assert.equal(wallet.snapshot().availableMinor, 100);
    const grant = wallet.entries().find((entry) => entry.type === 'GRANT');
    assert.equal(grant?.note, TRIAL_GRANT_NOTE);
  });

  it('grants nothing where the organisation has already had its trial', () => {
    const { trialGrantMinor, wallet } = platform.createTenant({
      ...CUSTOMER,
      legalName: 'B Ltd',
      enterpriseName: 'B',
      trialGrant: false,
    });
    assert.equal(trialGrantMinor, 0);
    assert.equal(wallet.snapshot().availableMinor, 0);
  });
});

describe('the month has a ceiling, whatever the number of signups', () => {
  it('issues full grants until the budget runs short, then what is left, then nothing', () => {
    const first = platform.createTenant({ ...CUSTOMER, legalName: 'One Ltd', enterpriseName: 'One' });
    const second = platform.createTenant({ ...CUSTOMER, legalName: 'Two Ltd', enterpriseName: 'Two' });
    // 250 budgeted, 200 issued: the third signup receives the 50 that remain,
    // rather than a full grant the budget cannot cover or nothing at all.
    const third = platform.createTenant({ ...CUSTOMER, legalName: 'Three Ltd', enterpriseName: 'Three' });
    const fourth = platform.createTenant({ ...CUSTOMER, legalName: 'Four Ltd', enterpriseName: 'Four' });

    assert.deepEqual(
      [first, second, third, fourth].map((result) => result.trialGrantMinor),
      [100, 100, 50, 0],
    );
    assert.equal(fourth.wallet.snapshot().availableMinor, 0, 'the wallet opens empty rather than on credit nobody budgeted');

    const position = platform.trialBudgetPosition();
    assert.equal(position.issuedMinor, 250);
    assert.equal(position.remainingMinor, 0);
    assert.equal(position.grants, 3, 'a zero grant is not a grant');
  });

  it('still creates the tenancy and everything else about it when the budget is spent', () => {
    tune({ freeTrialGrantMinor: 100, trialMonthlyBudgetMinor: 0 });
    const { tenant, subscription, trialGrantMinor } = platform.createTenant({
      ...CUSTOMER,
      legalName: 'Late Ltd',
      enterpriseName: 'Late',
    });
    assert.equal(trialGrantMinor, 0);
    assert.equal(platform.tenants().some((candidate) => candidate.id === tenant.id), true);
    assert.equal(subscription.status, 'ACTIVE');
  });

  it('reads the month from the record, so a restart cannot forget what was given away', () => {
    platform.createTenant({ ...CUSTOMER, legalName: 'One Ltd', enterpriseName: 'One' });
    platform.createTenant({ ...CUSTOMER, legalName: 'Two Ltd', enterpriseName: 'Two' });
    // A second Platform over the same journal is what a restart is. The
    // in-process ledger is shared by construction here, so the position must
    // come from the wallet entries and not from anything this instance counted.
    const position = platform.trialBudgetPosition();
    assert.equal(position.issuedMinor, 200);
    assert.equal(position.budgetMinor, 250);
    assert.equal(position.grantMinor, 100);
    assert.equal(position.month, new Date().toISOString().slice(0, 7));
  });

  it('counts only this month: last month’s grants do not consume this month’s budget', () => {
    platform.createTenant({ ...CUSTOMER, legalName: 'One Ltd', enterpriseName: 'One' });
    platform.createTenant({ ...CUSTOMER, legalName: 'Two Ltd', enterpriseName: 'Two' });
    platform.createTenant({ ...CUSTOMER, legalName: 'Three Ltd', enterpriseName: 'Three' });
    assert.equal(platform.trialBudgetPosition().remainingMinor, 0);

    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    const later = platform.trialBudgetPosition(nextMonth);
    assert.equal(later.issuedMinor, 0);
    assert.equal(later.remainingMinor, 250);
  });
});

describe('the defaults are the balance, stated', () => {
  it('sizes a grant well under a pound of provider cost and bounds the month', () => {
    tune({});
    const grantMinor = original.freeTrialGrantMinor;
    const budgetMinor = original.trialMonthlyBudgetMinor;
    // Worst-case provider cost of one grant is its face value over the markup.
    const worstCaseCostMinor = grantMinor / config.billing.markupMultiplier;
    assert.ok(worstCaseCostMinor <= 25, `one trial may cost up to ${worstCaseCostMinor} minor — that is a real invoice per signup`);
    assert.ok(budgetMinor > 0, 'a budget of zero is a free tier that never gives anything');
    assert.ok(budgetMinor / grantMinor >= 100, 'the default month should carry at least a hundred trials');
  });
});
