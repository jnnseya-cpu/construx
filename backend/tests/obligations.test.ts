import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as claims from '../src/engines/claims.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The obligations calendar.
 *
 * Two kinds of contractual obligation, and the distinction decides how each is
 * managed. A reactive one has no date until something happens and is lost by
 * not noticing. A dated one has a date the day the contract is signed —
 * insurance renewal, bond expiry, the end of the defects liability period — and
 * is missed precisely because nothing triggers it.
 *
 * The platform held the first kind and not the second. It could tell you a
 * notice was late; it could not tell you the bond expired last month.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
const contractId = () => platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;

describe('registering a dated obligation', () => {
  it('refuses one with nobody against it', () => {
    throwsCode(
      () =>
        claims.registerObligation(ctx('qs'), {
          contractId: contractId(),
          category: 'INSURANCE',
          description: 'Professional indemnity renewal',
          dueDate: '2027-01-01',
          owner: '   ',
        }),
      'OBLIGATION_OWNER_REQUIRED',
    );
  });

  it('refuses one with no date, because that is a different kind of obligation', () => {
    throwsCode(
      () =>
        claims.registerObligation(ctx('qs'), {
          contractId: contractId(),
          category: 'NOTICE_REQUIREMENTS',
          description: 'Serve within 14 days of becoming aware',
          dueDate: 'when it happens',
          owner: 'Project manager',
        }),
      'OBLIGATION_DUE_DATE_REQUIRED',
    );
  });

  it('records the three the seed registers', () => {
    const dated = platform.ledger
      .list(seed.projectId, 'Obligation')
      .filter((o) => typeof o.state.dueDate === 'string');

    assert.equal(dated.length, 3);
    assert.ok(dated.some((o) => String(o.state.category) === 'PERFORMANCE_BOND'));
  });
});

describe('the calendar', () => {
  it('derives the defects liability expiry from terms already recorded', () => {
    // Completion 30 September 2028, twenty-four months of defects liability.
    // Nobody types this date in; it follows from two terms the contract holds.
    const calendar = claims.obligationCalendar(ctx('qs'), '2030-06-01', 365);
    const dlp = calendar.entries.find((e) => e.reference === 'DLP-EXPIRY');

    assert.ok(dlp);
    assert.equal(dlp.dueDate, '2030-09-30');
    assert.equal(dlp.source, 'DERIVED_FROM_CONTRACT');
  });

  it('splits retention into the two halves it is actually released in', () => {
    // The second half falls due long after everybody has left the job, which is
    // why it is the one that goes missing.
    const calendar = claims.obligationCalendar(ctx('qs'), '2030-06-01', 365);

    const first = calendar.entries.find((e) => e.reference === 'RET-FIRST')!;
    const second = calendar.entries.find((e) => e.reference === 'RET-SECOND')!;

    assert.ok(first && second);
    assert.equal(first.dueDate, '2028-09-30', 'released at practical completion');
    assert.equal(second.dueDate, '2030-09-30', 'released at the end of the defects period');

    // The first half fell due two years ago and the platform has no record of
    // anybody asking for it. Showing it as overdue is the point — unreleased
    // retention is real money that goes quiet rather than disappearing.
    assert.equal(first.status, 'OVERDUE');
    assert.equal(second.status, 'DUE');
  });

  it('derives nothing where the contract never recorded the term', () => {
    // A contract with no defects liability period produces no expiry entry
    // rather than an invented one.
    const bare = claims.createContract(ctx('qs'), {
      suite: 'JCT',
      form: 'JCT Minor Works 2016',
      parties: [{ role: 'CLIENT', partyId: 'C1', name: 'A client' }],
      contractSumMinor: 4_000_000,
      commencementDate: '2026-09-01',
      completionDate: '2027-03-01',
      liquidatedDamagesPerDayMinor: 10_000,
      ldCapPercent: 5,
      retentionPercent: 0,
      defectsLiabilityMonths: 0,
    });

    const calendar = claims.obligationCalendar(ctx('qs'), '2026-08-20', 3650);
    const derived = calendar.entries.filter((e) => e.entityRef?.refId === bare.contractId);
    assert.deepEqual(derived, []);
  });

  it('rolls a recurring obligation forward rather than leaving it overdue forever', () => {
    // The quarterly review was due 1 August 2026. By November it is not an
    // outstanding failure — it is due again.
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-10-15', 180);
    const review = calendar.entries.find((e) => e.category === 'REVIEW_CYCLE')!;

    assert.ok(review);
    assert.equal(review.dueDate, '2026-11-01', 'rolled forward one quarter');
    assert.notEqual(review.dueDate, '2026-08-01');

    // And it says so, rather than implying the earlier ones were held.
    assert.match(review.description, /earlier occurrences are not recorded/);
  });

  it('reports the bond expiry as overdue once its date has passed', () => {
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-11-10', 180);

    const bond = calendar.overdue.find((e) => e.category === 'PERFORMANCE_BOND');

    assert.ok(bond, 'a bond that expired ten days ago should be overdue');
    assert.ok(bond.daysRemaining < 0);
  });

  it('marks an obligation approaching within thirty days differently from one months out', () => {
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-09-01', 365);
    const insurance = calendar.entries.find((e) => e.category === 'INSURANCE')!;
    const bond = calendar.entries.find((e) => e.category === 'PERFORMANCE_BOND')!;

    assert.equal(insurance.status, 'APPROACHING', '15 September is two weeks away');
    assert.equal(bond.status, 'DUE', '31 October is not yet approaching');
  });

  it('orders by date and names the next thing that has to happen', () => {
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-09-01', 365);
    const dates = calendar.entries.map((e) => e.dueDate);
    assert.deepEqual(dates, [...dates].sort());

    assert.ok(calendar.nextDue);
    assert.equal(calendar.nextDue.category, 'INSURANCE');
  });

  it('keeps the running time bars out of the dated list', () => {
    // A list mixing "renew the policy by March" with "serve within 14 days of
    // an event that has not happened" is unusable, so they are reported apart.
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-09-01', 365);
    assert.ok(calendar.running.length > 0, 'the seed records delay events');
    assert.equal(calendar.entries.some((e) => e.dueDate === undefined), false);
  });

  it('ignores a time bar on an event that carried no entitlement', () => {
    // A contractor-risk productivity delay has neither time nor money in it, so
    // there was no notice worth serving and nothing was lost. Reporting it
    // would be crying wolf, and the real ones then get skimmed past.
    const calendar = claims.obligationCalendar(ctx('qs'), '2030-01-01', 365);
    const contractorRisk = calendar.running.find((r) => /productivity/i.test(r.trigger));
    assert.equal(contractorRisk, undefined);

    // The employer-risk and neutral events are still tracked.
    assert.ok(calendar.running.length > 0);
  });

  it('says which time bars have run without a notice, and calls them lost', () => {
    // The distinction that matters: a late insurance renewal is a gap to close,
    // a missed time bar is gone. Putting both in one list without saying which
    // is which lets the recoverable ones absorb the attention.
    const calendar = claims.obligationCalendar(ctx('qs'), '2030-01-01', 365);
    for (const running of calendar.running) {
      assert.equal(typeof running.lost, 'boolean');
      if (running.lost) assert.equal(running.served, false);
    }
  });

  it('says plainly when nothing falls due in the window', () => {
    const calendar = claims.obligationCalendar(ctx('qs'), '2026-08-20', 1);
    // The horizon is a single day, so nothing dated is in range; the running
    // time bars are still reported because they do not have a due date.
    assert.equal(calendar.entries.filter((e) => e.daysRemaining > 1).length, 0);
  });

  it('will not show the calendar to a role with no contracts read', () => {
    assert.throws(() => claims.obligationCalendar(platform.context(seed.users.safety!.auth, seed.projectId)));
  });
});
