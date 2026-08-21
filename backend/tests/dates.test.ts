import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { assertNotFuture, assertNotPast, assertOrder } from '../src/domain/dates.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * Date invariants.
 *
 * `format: 'date'` proved a string was shaped like a date and nothing else, so
 * three things were accepted that should never have been: a delay that ended
 * before it started, a project that completed before it began, and a notice
 * dated in the future. All three land in an append-only ledger, where a wrong
 * date is not a bad field but a permanent record.
 *
 * The guard found one the moment it was switched on: the seeded asset register
 * carried an installation date of 2027-11-15 on a project already taken through
 * to HANDOVER, with a fifteen-year replacement plan counted from it.
 */

/** A fixed day to reason against, so these tests do not depend on the clock. */
const NOW = new Date('2026-08-21T09:00:00.000Z');

describe('a date that records something that has already happened', () => {
  it('accepts today', () => {
    assert.doesNotThrow(() => assertNotFuture('2026-08-21', 'issuedDate', NOW));
  });

  it('accepts the past', () => {
    assert.doesNotThrow(() => assertNotFuture('2019-06-01', 'installedAt', NOW));
  });

  it('refuses tomorrow, and names the field', () => {
    try {
      assertNotFuture('2026-08-22', 'issuedDate', NOW);
      assert.fail('a notice issued tomorrow was accepted');
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'VALIDATION_FAILED');
      assert.deepEqual((error as { fieldErrors: unknown }).fieldErrors, [
        { field: 'issuedDate', message: 'must not be later than 2026-08-21' },
      ]);
    }
  });

  it('compares the day, not the instant, so a date-time later today passes', () => {
    // Times are recorded in UTC and read in local zones. Refusing 23:00 today
    // because it is after 09:00 today would reject a notice served this evening
    // in a timezone ahead of the server.
    assert.doesNotThrow(() => assertNotFuture('2026-08-21T23:30:00.000Z', 'servedDate', NOW));
  });
});

describe('a date by which something must still happen', () => {
  it('accepts today and the future', () => {
    assert.doesNotThrow(() => assertNotPast('2026-08-21', 'dueDate', NOW));
    assert.doesNotThrow(() => assertNotPast('2027-01-01', 'dueDate', NOW));
  });

  it('refuses a due date that was already overdue when it was set', () => {
    throwsCode(() => assertNotPast('2026-08-20', 'dueDate', NOW), 'VALIDATION_FAILED');
  });
});

describe('two dates that bound a period', () => {
  it('allows a period that begins and ends on the same day', () => {
    // A delay, an inspection and an occupation can all be a single day.
    assert.doesNotThrow(() => assertOrder('2026-08-21', '2026-08-21', 'start', 'end'));
  });

  it('refuses an end before its start, and points at the end', () => {
    try {
      assertOrder('2026-08-21', '2026-08-01', 'start', 'end');
      assert.fail('a delay that ended before it started was accepted');
    } catch (error) {
      assert.deepEqual((error as { fieldErrors: unknown }).fieldErrors, [
        { field: 'end', message: 'must not be earlier than start (2026-08-21)' },
      ]);
    }
  });
});

describe('the guards where the platform applies them', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  const admin = () => platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolioId = () => String(platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.state.id);

  const project = (plannedStart: string, plannedCompletion: string) => ({
    portfolioId: portfolioId(),
    name: 'Kielder spillway strengthening',
    sectorType: 'UTILITIES' as const,
    assetType: 'Reservoir spillway',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Hexham' },
    contractValueMinor: 940_000_000,
    currency: 'GBP',
    plannedStart,
    plannedCompletion,
  });

  it('refuses a project that completes before it starts', () => {
    throwsCode(
      () => structure.createProject(admin(), project('2027-01-11', '2026-06-30')),
      'VALIDATION_FAILED',
      'a project completing before it starts was accepted',
    );
  });

  it('still accepts a project whose dates run the right way round', () => {
    assert.doesNotThrow(() => structure.createProject(admin(), project('2027-01-11', '2028-06-30')));
  });
});
