import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as business from '../src/domain/business.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { entriesByCodePrefix } from '../src/notifications/outbox.ts';
import { sweepTenderReminders, resetTenderReminders } from '../src/ops/tenderreminders.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The tender-deadline reminder sweep.
 *
 * A bid is lost on the one thing estimating cannot save — the date. The platform
 * holds every recorded invitation's deadline as a single instant; this reads
 * them on a timer and tells the company's own people a set number of days out,
 * through the same outbox every other notice uses. These tests pin the three
 * things that make it trustworthy: it reminds the ones inside the window, it
 * does not nag — one reminder per deadline, not one per sweep — and it leaves a
 * pursuit that has been decided a no-bid alone.
 */

let platform: Platform;
let seed: SeedResult;

const flat = (value: number): business.QualificationScores =>
  Object.fromEntries(business.QUALIFICATION_CRITERIA.map((c) => [c.key, value])) as business.QualificationScores;

let counter = 0;

/** A qualified opportunity in this tenancy's governance project, with an invitation on it. */
function invitationWithDeadline(returnLocal: string, decide?: 'NO_BID'): { opportunityId: string; invitationId: string } {
  counter += 1;
  const owner = platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const qs = platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

  const { opportunityId } = business.registerOpportunity(owner, {
    title: `Reminder fixture ${counter}`,
    clientName: 'South Holland District Council',
    sectorType: 'COMMERCIAL',
    estimatedValueMinor: 8_600_000_00,
    source: 'In-Tend portal',
  });
  business.qualifyOpportunity(owner, opportunityId, flat(4));
  if (decide === 'NO_BID') {
    business.decideBidNoBid(owner, opportunityId, {
      bid: false,
      rationale: 'Outside our geography for this cycle.',
      // The algorithm recommends a bid at this score, so declining it is a
      // decision taken under a named authority.
      authority: { delegatedTo: 'Managing Director', reference: 'Bid approval policy §2' },
    });
  }

  const { invitationId } = tenderintake.recordInvitation(qs, opportunityId, {
    reference: `SHDC-${counter}`,
    issuedAt: '2027-01-11T09:00:00.000Z',
    returnLocal,
    timeZone: 'Europe/London',
    timeZoneStated: true,
    channel: 'PORTAL',
  });
  return { opportunityId, invitationId };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  resetTenderReminders();
});

describe('tender deadline reminders', () => {
  // Noon on 12 March 2027, London; "now" is set relative to this in each test.
  const RETURN = '2027-03-12T12:00';

  it('reminds the company when a deadline is inside the lead window, and not before', async () => {
    const near = invitationWithDeadline(RETURN); // ~3 days before the 9th
    const far = invitationWithDeadline('2027-05-01T12:00'); // weeks away

    // Noon on the 9th is exactly three days before noon on the 12th (GMT — the
    // clocks do not go forward until the 28th), inside the five-day window.
    const outcome = await sweepTenderReminders(platform, new Date('2027-03-09T12:00:00Z'));

    const sentIds = outcome.sent.map((s) => s.invitationId);
    assert.ok(sentIds.includes(near.invitationId), 'the invitation three days out is reminded');
    assert.ok(!sentIds.includes(far.invitationId), 'the invitation weeks out is not');

    const sent = outcome.sent.find((s) => s.invitationId === near.invitationId)!;
    assert.ok(sent.recipients >= 1, 'the reminder reached at least one account holder');
    assert.equal(sent.daysRemaining, 3);

    // The notice is on the record, keyed by the deadline in force, so a later
    // sweep can tell it was already sent.
    const queued = entriesByCodePrefix(platform, 'tender.deadline_approaching', Number.MAX_SAFE_INTEGER);
    assert.ok(queued.some((entry) => entry.payload.invitationId === near.invitationId));
  });

  it('does not remind a deadline that has already passed', async () => {
    const past = invitationWithDeadline('2027-03-01T12:00');
    const outcome = await sweepTenderReminders(platform, new Date('2027-03-09T09:00:00Z'));
    assert.ok(!outcome.sent.some((s) => s.invitationId === past.invitationId));
  });

  it('sends one reminder per deadline, however often the sweep runs', async () => {
    const { invitationId } = invitationWithDeadline(RETURN);

    const first = await sweepTenderReminders(platform, new Date('2027-03-09T09:00:00Z'));
    assert.ok(first.sent.some((s) => s.invitationId === invitationId), 'sent on the first sweep');

    const second = await sweepTenderReminders(platform, new Date('2027-03-09T15:00:00Z'));
    assert.ok(!second.sent.some((s) => s.invitationId === invitationId), 'not sent again on the second');
    assert.ok(second.alreadyReminded >= 1, 'counted as already reminded');
  });

  it('leaves a pursuit decided a no-bid alone', async () => {
    const { invitationId } = invitationWithDeadline(RETURN, 'NO_BID');
    const outcome = await sweepTenderReminders(platform, new Date('2027-03-09T09:00:00Z'));
    assert.ok(!outcome.sent.some((s) => s.invitationId === invitationId), 'a no-bid is not reminded');
    assert.ok(
      outcome.skipped.some((s) => s.invitationId === invitationId && /no-bid/i.test(s.because)),
      'and the skip names why',
    );
  });
});
