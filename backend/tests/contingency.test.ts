import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as cost from '../src/engines/cost.ts';
import * as learning from '../src/domain/learning.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The risk allowance, and what it turned out to be worth.
 *
 * The cost baseline priced a contingency from the first day the engine existed,
 * and nothing ever spent one. The figure was approved, carried and never moved
 * again — which meant the record could say what a job *expected* risk to cost
 * and never what it did.
 *
 * A risk allowance nobody draws against is right by construction. Nothing can
 * contradict it, so it is never wrong, so it never improves. That is also why
 * the learning loop had four calibration signals where §4.10.2 asks for the
 * risk distribution alongside rates, productivity and win probability: the
 * other three had records behind them and this one had a priced figure with no
 * outturn to compare it with.
 *
 * What these tests hold:
 *
 * **A draw names the risk that materialised.** Without that rule the
 * contingency becomes the place overspend goes to stop being visible, and a
 * calibration derived from it measures nothing. Refusing the unnamed draw is
 * what makes the signal mean something.
 *
 * **A draw beyond the allowance is spending the margin.** Refused and named as
 * that, rather than quietly running the pot negative.
 *
 * **An untouched allowance is not evidence it was right.** A job that has not
 * drawn may be well priced or may simply not have finished, and the signal
 * counts only baselines something has actually come out of.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds BUDGET_COST A — approves the baseline, so may spend the risk pot. */
const asCommercial = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
/** Reads the calibration, which is a tenancy question rather than a project one. */
const asGovernance = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the catalogue and the route', () => {
  it('carries the draw as an approval on the budget it comes out of', () => {
    const def = lookupEventType('BUDGET_CONTINGENCY_DRAWN');
    assert.ok(def, 'BUDGET_CONTINGENCY_DRAWN is not in the closed catalogue');
    assert.equal(def.entity, 'Budget');
    // Approval, not update: it moves money out of the allowance the job was
    // priced with, and that is the same authority that set the baseline.
    assert.equal(def.action, 'APPROVE');
  });

  it('publishes both halves — the draw and the position', () => {
    const draw = ROUTES.find((r) => r.pattern === '/v1/projects/:projectId/cost/contingency-draw');
    const read = ROUTES.find((r) => r.pattern === '/v1/projects/:projectId/cost/contingency');
    assert.ok(draw, 'no route draws against the contingency');
    assert.equal(draw.method, 'POST');
    assert.ok(read, 'no route reports the contingency position');
    assert.equal(read.method, 'GET');
    assert.equal(read.readOnly, true);
  });
});

describe('the position, before anything is drawn', () => {
  it('reports what was priced and that none of it has gone', () => {
    const position = cost.contingencyPosition(asCommercial());
    assert.ok(position.budgetId, 'the seeded project has no approved baseline');
    assert.ok(position.pricedMinor > 0, 'the seeded baseline prices no contingency');
    assert.equal(position.drawnMinor, 0);
    assert.equal(position.remainingMinor, position.pricedMinor);
    assert.equal(position.consumedPercent, 0);
    assert.deepEqual(position.draws, []);
  });
});

describe('what a draw refuses', () => {
  it('refuses a draw of nothing', () => {
    for (const amountMinor of [0, -500]) {
      throwsCode(
        () => cost.drawBudgetContingency(asCommercial(), { amountMinor, riskReference: 'RISK-1', reason: 'Ground conditions worse than surveyed' }),
        'CONTINGENCY_AMOUNT_INVALID',
      );
    }
  });

  it('refuses a draw that names no risk', () => {
    // The rule the whole calibration rests on. Money spent on something nobody
    // identified is an underestimate or a scope change.
    throwsCode(
      () => cost.drawBudgetContingency(asCommercial(), { amountMinor: 100_000, riskReference: '   ', reason: 'Ground conditions worse than surveyed' }),
      'CONTINGENCY_RISK_REQUIRED',
    );
  });

  it('refuses a draw with no usable reason', () => {
    throwsCode(
      () => cost.drawBudgetContingency(asCommercial(), { amountMinor: 100_000, riskReference: 'RISK-1', reason: 'because' }),
      'CONTINGENCY_REASON_REQUIRED',
    );
  });

  it('refuses a draw beyond what remains, and calls it spending the margin', () => {
    const position = cost.contingencyPosition(asCommercial());
    try {
      cost.drawBudgetContingency(asCommercial(), {
        amountMinor: position.remainingMinor + 1,
        riskReference: 'RISK-9',
        reason: 'A risk larger than the whole allowance carried for it',
      });
      assert.fail('a draw beyond the allowance was accepted');
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'CONTINGENCY_EXHAUSTED');
      assert.match((error as Error).message, /margin/);
    }
  });
});

describe('a draw that lands', () => {
  it('moves the position and keeps what it was for', () => {
    const before = cost.contingencyPosition(asCommercial());
    const result = cost.drawBudgetContingency(asCommercial(), {
      amountMinor: 4_000_000,
      riskReference: 'RISK-014',
      reason: 'Made ground below the east wing, deeper than the survey showed',
    });

    assert.equal(result.pricedMinor, before.pricedMinor);
    assert.equal(result.drawnMinor, 4_000_000);
    assert.equal(result.remainingMinor, before.pricedMinor - 4_000_000);

    const after = cost.contingencyPosition(asCommercial());
    assert.equal(after.drawnMinor, 4_000_000);
    assert.equal(after.draws.length, 1);
    assert.equal(after.draws[0]!.riskReference, 'RISK-014');
    assert.match(after.draws[0]!.reason, /Made ground/);
    assert.ok(after.draws[0]!.drawnBy, 'a draw does not say who made it');
    assert.ok(after.consumedPercent !== null && after.consumedPercent > 0);
  });

  it('accumulates rather than replacing', () => {
    const before = cost.contingencyPosition(asCommercial());
    cost.drawBudgetContingency(asCommercial(), {
      amountMinor: 1_500_000,
      riskReference: 'RISK-021',
      reason: 'Temporary works redesign after the crane position moved',
    });
    const after = cost.contingencyPosition(asCommercial());
    assert.equal(after.drawnMinor, before.drawnMinor + 1_500_000);
    assert.equal(after.draws.length, before.draws.length + 1);
  });
});

describe('what the allowance is worth, as a calibration signal', () => {
  it('derives a risk signal once a baseline has been drawn against', () => {
    const reading = learning.calibrationSignals(asGovernance());
    const signal = reading.signals.find((entry) => entry.kind === 'RISK_CONTINGENCY');
    assert.ok(signal, 'nothing calibrates the risk allowance after two draws');
    assert.ok(signal.observations >= 1);
    assert.ok(signal.deltaPercent !== null);
    // The delta is the distance from the allowance being exactly spent, so a
    // positive figure is risk carried and not needed.
    assert.ok(signal.deltaPercent! > 0, 'a part-consumed allowance did not read as over-priced');
    assert.match(signal.reading, /allowance/);
    assert.ok(signal.sources.length > 0, 'the signal names no baseline behind it');
  });

  it('publishes what a promoted risk lesson would and would not change', () => {
    const register = learning.lessonRegister(asGovernance());
    const effect = register.effects.find((entry) => entry.kind === 'RISK_CONTINGENCY');
    assert.ok(effect, 'the register does not say what a risk lesson does');
    // It reports and never moves a contingency. How much risk to carry on a
    // particular job is a judgement about that job.
    assert.match(effect.effect, /moves\s+no contingency/);
  });

  it('says an untouched allowance is not evidence it was right', () => {
    // A second tenancy with a priced, undrawn baseline. The signal must stay
    // silent and the limit must say why, rather than reporting nought per cent
    // consumed as though the pricing had been proved.
    const fresh = new Platform();
    return seedDemoProject(fresh).then((other) => {
      const ctx = fresh.context(other.users.owner!.auth, `${other.tenantId}-governance`, { source: 'WEB' });
      const reading = learning.calibrationSignals(ctx);
      assert.equal(
        reading.signals.find((entry) => entry.kind === 'RISK_CONTINGENCY'),
        undefined,
        'an undrawn allowance produced a calibration signal',
      );
      assert.ok(
        reading.limits.some((limit) => /drawn against/.test(limit)),
        `no limit explains the absent risk signal: ${reading.limits.join(' | ')}`,
      );
    });
  });
});
