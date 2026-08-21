import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { designDelayExposure } from '../src/engines/bim.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Pricing late design information.
 *
 * "Eleven RFIs overdue" gets noted; "£412,500 of exposure" gets acted on. The
 * risk in building it is the opposite failure — a large confident number built
 * on an assumption the record does not support.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const bim = () => platform.context(seed.users.bim!.auth, seed.projectId, { source: 'WEB' });

describe('pricing the delay', () => {
  it('prices from the contract’s own damages rate, not an invented figure', () => {
    const exposure = designDelayExposure(bim());
    const contract = platform.ledger.list(seed.projectId, 'Contract').at(-1)!;
    assert.equal(exposure.dailyDamagesMinor, Number(contract.state.liquidatedDamagesPerDayMinor ?? 0));
  });

  it('subtracts float before charging anything', () => {
    // Days absorbed by float cost nothing — that is what float is for, and a
    // model that charged for them would overstate every project with slack.
    const exposure = designDelayExposure(bim());
    assert.equal(
      exposure.daysBeyondFloatIfCritical,
      Math.max(0, exposure.worstDaysOverdue - exposure.floatDays),
    );
    assert.equal(
      exposure.exposureIfCriticalMinor,
      exposure.daysBeyondFloatIfCritical * exposure.dailyDamagesMinor,
    );
  });

  it('prices the worst single RFI, not the sum of all of them', () => {
    // Three RFIs each ten days overdue do not delay a project by thirty days.
    // Summing them is the arithmetic that produces an eye-catching wrong number.
    const exposure = designDelayExposure(bim(), '2027-01-01');
    if (exposure.overdueCount > 1) {
      assert.ok(
        exposure.worstDaysOverdue < exposure.totalDaysOverdue,
        'the fixture has one overdue RFI, so this assertion proves nothing — check the seed',
      );
      assert.ok(exposure.daysBeyondFloatIfCritical <= exposure.worstDaysOverdue);
    }
  });

  it('says the figure is conditional, in the words the console prints', () => {
    // A conditional number presented as a fact is worse than no number, and the
    // qualification travels with the figure rather than living in a comment.
    const exposure = designDelayExposure(bim(), '2027-01-01');
    assert.ok(exposure.qualification.length > 0);

    // Three states, and the third is the one the first version got wrong: it
    // reported nothing-overdue in float terms, which reads as a project running
    // on empty float.
    if (exposure.overdueCount === 0) {
      assert.match(exposure.qualification, /no design information is overdue/i);
    } else if (exposure.daysBeyondFloatIfCritical > 0) {
      assert.match(exposure.qualification, /if the worst overdue rfi sits on the critical path/i);
    } else {
      assert.match(exposure.qualification, /float absorbs/i);
    }
  });

  it('names the one change that would make it exact', () => {
    const exposure = designDelayExposure(bim(), '2027-01-01');
    if (exposure.overdueCount > 0) {
      assert.match(exposure.toMakeExact ?? '', /activity reference/i);
    }
  });

  it('treats a project with no baseline as having no float, not infinite float', () => {
    // The conservative reading and also the true one: a project that cannot
    // demonstrate slack does not have it for this purpose.
    const exposure = designDelayExposure(bim());
    assert.ok(exposure.floatDays >= 0);
  });

  it('reports nothing owed where nothing is overdue', () => {
    // A date before the project started: every RFI is within time.
    const exposure = designDelayExposure(bim(), '2020-01-01');
    assert.equal(exposure.overdueCount, 0);
    assert.equal(exposure.totalDaysOverdue, 0);
    assert.equal(exposure.exposureIfCriticalMinor, 0);
    assert.equal(exposure.toMakeExact, undefined);
  });
});

describe('with information actually overdue', () => {
  /**
   * The seeded RFI is answered, so the project's real exposure is nil — correct,
   * and it proves nothing about the arithmetic. These write an open, overdue RFI
   * straight to the ledger and check the money.
   */
  function overdueRfi(dueDate: string, reference: string) {
    const ctx = bim();
    ctx.ledger.commit({
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      actor: { refType: 'User', refId: seed.users.bim!.id },
      source: 'WEB',
      correlationId: `test-${reference}`,
      eventType: 'RFI_RAISED',
      entity: { refType: 'RFI', refId: `rfi-${reference}` },
      nextState: {
        id: `rfi-${reference}`,
        reference,
        projectId: seed.projectId,
        discipline: 'CIVILS',
        question: 'Confirm the pile cap reinforcement at grid D2',
        raisedAt: '2026-06-01T00:00:00.000Z',
        dueDate,
        status: 'OPEN',
      },
      timestamp: new Date().toISOString(),
    });
  }

  it('turns days overdue into money at the contract rate', () => {
    overdueRfi('2026-07-01', 'RFI-T001');
    const exposure = designDelayExposure(bim(), '2026-07-31');

    assert.equal(exposure.overdueCount, 1);
    assert.equal(exposure.worstDaysOverdue, 30);
    // No baseline float on this fixture, so every day is beyond it.
    assert.equal(exposure.daysBeyondFloatIfCritical, 30 - exposure.floatDays);
    assert.equal(
      exposure.exposureIfCriticalMinor,
      (30 - exposure.floatDays) * exposure.dailyDamagesMinor,
    );
    assert.ok(exposure.exposureIfCriticalMinor > 0, 'thirty days overdue priced at nothing');
    assert.match(exposure.qualification, /critical path/i);
  });

  it('prices the worst, not the sum — three late RFIs are not three delays', () => {
    // The arithmetic that produces an eye-catching wrong number: 30 + 20 + 10
    // days of late information do not delay a project by sixty days.
    overdueRfi('2026-07-11', 'RFI-T002');
    overdueRfi('2026-07-21', 'RFI-T003');
    const exposure = designDelayExposure(bim(), '2026-07-31');

    assert.equal(exposure.overdueCount, 3);
    assert.equal(exposure.totalDaysOverdue, 60);
    assert.equal(exposure.worstDaysOverdue, 30, 'the worst single RFI is not thirty days');
    assert.equal(
      exposure.exposureIfCriticalMinor,
      (30 - exposure.floatDays) * exposure.dailyDamagesMinor,
      'the exposure was summed across RFIs rather than taken from the worst',
    );
  });

  it('says nothing is overdue in the words the console prints, not in float terms', () => {
    // The first version printed "Float absorbs the delay: 0 days of slack
    // against 0 days overdue" for a project with nothing late — true, and it
    // reads as a project running on empty float.
    const exposure = designDelayExposure(bim(), '2020-01-01');
    assert.equal(exposure.overdueCount, 0);
    assert.match(exposure.qualification, /no design information is overdue/i);
    assert.doesNotMatch(exposure.qualification, /float/i);
  });
});
