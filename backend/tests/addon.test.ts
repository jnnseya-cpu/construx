import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addonMonthlyMinor,
  addonMonthlyMinorForSeats,
  canAllocateSeat,
  effectiveEntitlement,
  historyReadable,
  moduleUsable,
  seatsToUnassign,
} from '../src/billing/addon.ts';

/**
 * The Grid Connection AI commercial contract (spec §1–2) as pure logic: the £100 +
 * £50×seat money maths, the three-state entitlement machine, and seat capacity.
 */

describe('add-on pricing (spec §1)', () => {
  it('is £100 + £50 per additional seat', () => {
    assert.equal(addonMonthlyMinor(0), 10_000); // 1 seat → £100
    assert.equal(addonMonthlyMinor(1), 15_000); // 2 seats → £150
    assert.equal(addonMonthlyMinor(2), 20_000); // 3 seats → £200
    assert.equal(addonMonthlyMinor(4), 30_000); // 5 seats → £300
  });

  it('prices by total seat count (the base always includes one)', () => {
    assert.equal(addonMonthlyMinorForSeats(1), 10_000);
    assert.equal(addonMonthlyMinorForSeats(3), 20_000);
    assert.throws(() => addonMonthlyMinorForSeats(0));
    assert.throws(() => addonMonthlyMinor(-1));
    assert.throws(() => addonMonthlyMinor(1.5));
  });
});

describe('effective entitlement (spec §2 — grant AND provider)', () => {
  it('is LOCKED without a Platform-Admin grant, whatever the provider says', () => {
    assert.equal(effectiveEntitlement(false, 'ACTIVE'), 'LOCKED');
    assert.equal(effectiveEntitlement(false, 'PAST_DUE_GRACE'), 'LOCKED');
  });

  it('maps provider status to the entitlement the spec table requires', () => {
    assert.equal(effectiveEntitlement(true, 'PENDING'), 'LOCKED');
    assert.equal(effectiveEntitlement(true, 'ACTIVE'), 'ACTIVE');
    assert.equal(effectiveEntitlement(true, 'PAST_DUE_GRACE'), 'GRACE');
    assert.equal(effectiveEntitlement(true, 'SUSPENDED'), 'STOPPED');
    assert.equal(effectiveEntitlement(true, 'EXPIRED'), 'STOPPED');
    assert.equal(effectiveEntitlement(true, 'CANCEL_AT_PERIOD_END'), 'ENDING');
  });

  it('permits new module use only when ACTIVE or ENDING; grace and stopped are read-only; locked reads nothing', () => {
    assert.equal(moduleUsable('ACTIVE'), true);
    assert.equal(moduleUsable('ENDING'), true);
    assert.equal(moduleUsable('GRACE'), false);
    assert.equal(moduleUsable('STOPPED'), false);
    assert.equal(moduleUsable('LOCKED'), false);

    assert.equal(historyReadable('GRACE'), true);
    assert.equal(historyReadable('STOPPED'), true);
    assert.equal(historyReadable('LOCKED'), false);
  });
});

describe('seat capacity (spec §2 seat rules)', () => {
  it('allows a new allocation only within the paid quantity', () => {
    assert.equal(canAllocateSeat(3, 2), true);
    assert.equal(canAllocateSeat(3, 3), false);
  });

  it('computes how many seats must be unassigned before a decrease', () => {
    assert.equal(seatsToUnassign(3, 1), 2); // decreasing 3→1 with 3 active needs 2 released
    assert.equal(seatsToUnassign(2, 3), 0); // increasing never forces a release
    assert.equal(seatsToUnassign(1, 1), 0);
  });
});
