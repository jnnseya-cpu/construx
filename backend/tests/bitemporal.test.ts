import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as evidence from '../src/domain/evidenceclaim.ts';
import { stateAsOf, temporalHistory, validFromOf } from '../src/goldenthread/bitemporal.ts';
import { chainBody } from '../src/goldenthread/ledger.ts';
import { replayProject } from '../src/goldenthread/replay.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Two time axes — `L7.4`.
 *
 * *What did we know on the fourteenth about the twelfth* is not the same
 * question as *what was true on the twelfth*, and the ledger could answer only
 * one of them: it always knew when a thing was recorded, and never when it
 * became true. Reading today's state to answer either reports the present
 * understanding of the past as though it had been understood at the time, which
 * is exactly the mistake an adjudicator is looking for.
 *
 * These tests are about the four properties that make the second axis worth
 * having: an **absent value is not a gap**, the axis is **inside the chain
 * without disturbing it**, the platform **refuses a question about the
 * future**, and a late record is **visible as a late record** rather than
 * silently equivalent to a prompt one.
 */

let platform: Platform;
let seed: SeedResult;
let governanceId: string;
let claimId: string;

/** Holds ESTIMATE_TENDER C — asserts a claim against a certificate. */
const asQS = () => platform.context(seed.users.qs!.auth, governanceId, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — verifies one. */
const asOwner = () => platform.context(seed.users.owner!.auth, governanceId, { source: 'WEB' });

const CERTIFICATE = `sha256:${'a1'.repeat(32)}`;
const PROMPT = `sha256:${'b2'.repeat(32)}`;

/** A date that many days before today, as YYYY-MM-DD. */
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  governanceId = `${seed.tenantId}-governance`;

  // The case the axis exists for: a certificate issued ninety days ago and
  // filed today. The cover was in place throughout; the record of it was not.
  claimId = evidence.assertClaim(asQS(), {
    kind: 'INSURANCE',
    claim: 'Public liability cover of £10m held throughout the works',
    sourceHash: CERTIFICATE,
    issuedBy: 'Fenwick Underwriting',
    issuedAt: daysAgo(90),
    expiresAt: new Date(Date.now() + 275 * 86_400_000).toISOString().slice(0, 10),
  }).id;
});

describe('an absent second axis is not a gap', () => {
  it('reads an event with no validFrom as true from the moment it was recorded', () => {
    // Every event written before this existed carries nothing, and nothing is
    // backfilled onto an event that is already hash-chained. The default has to
    // be the correct answer rather than a missing one.
    const events = platform.ledger.eventsForEntity({ refType: 'Project', refId: seed.projectId });
    assert.ok(events.length > 0, 'the seeded project has a stream');
    for (const event of events) {
      assert.equal(event.validFrom, undefined, 'nothing backfilled a project event');
      assert.equal(validFromOf(event), event.timestamp);
    }
  });

  it('leaves the canonical body of an event that does not state one untouched', () => {
    const event = platform.ledger.eventsForEntity({ refType: 'Project', refId: seed.projectId })[0]!;
    // An absent optional field is not in the canonical body, so adding the
    // field to the type changed no hash already written. Asserted rather than
    // reasoned about: this is the property the whole chain rests on.
    assert.ok(!chainBody(event).includes('validFrom'));
  });

  it('still verifies the chain end to end after a backdated event joined it', () => {
    const report = replayProject(platform.ledger, seed.tenantId, governanceId, new Date().toISOString(), {
      audience: 'INTERNAL',
    });
    assert.equal(report.verificationStatus, 'VERIFIED');
    assert.equal(report.failures.length, 0);
  });
});

describe('a fact recorded late', () => {
  it('records when the certificate was issued, not only when it was filed', () => {
    const events = platform.ledger.eventsForEntity({ refType: 'EvidenceClaim', refId: claimId });
    const asserted = events.find((event) => event.eventType === 'EVIDENCE_CLAIM_ASSERTED')!;

    assert.equal(asserted.validFrom, `${daysAgo(90)}T00:00:00.000Z`);
    assert.ok(asserted.validFrom! < asserted.timestamp, 'issued before it was filed');
    // And it is inside the chain from the moment it was written, so there is no
    // path that edits it afterwards.
    assert.ok(chainBody(asserted).includes('validFrom'));
  });

  it('answers what cover was in place two months ago, which today-only reading cannot', () => {
    const twoMonthsAgo = `${daysAgo(60)}T12:00:00.000Z`;
    const now = new Date().toISOString();

    // Known now, true then: the certificate was already in force.
    const known = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId }, {
      recordedBy: now,
      validAt: twoMonthsAgo,
    });
    assert.ok(known.state, 'the claim was true two months ago');
    assert.equal(known.state!.sourceHash, CERTIFICATE);

    // Known then, true then: nobody had filed it, so the platform had nothing.
    const knownThen = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId }, {
      recordedBy: twoMonthsAgo,
      validAt: twoMonthsAgo,
    });
    assert.equal(knownThen.state, undefined);
    assert.ok(knownThen.excluded.notYetRecorded > 0, 'said as an exclusion rather than left as a silent difference');
  });

  it('excludes a fact that had not become true yet, and says so', () => {
    const before = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId }, {
      recordedBy: new Date().toISOString(),
      validAt: `${daysAgo(120)}T00:00:00.000Z`,
    });
    assert.equal(before.state, undefined);
    assert.equal(before.excluded.notYetRecorded, 0);
    assert.ok(before.excluded.notYetTrue > 0, 'the certificate did not exist a hundred and twenty days ago');
  });

  it('names the last event that contributed, so the answer traces to a line of audit', () => {
    const now = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId });
    assert.ok(now.throughEventId, 'an answer with no event behind it is an assertion');
    const events = platform.ledger.eventsForEntity({ refType: 'EvidenceClaim', refId: claimId });
    assert.ok(events.some((event) => event.eventId === now.throughEventId));
  });

  it('agrees with the materialised record when asked about now', () => {
    // The projection and the ledger's own state must not be able to disagree.
    // If they can, one of them is a second copy of the truth.
    const now = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId });
    const record = platform.ledger.get({ refType: 'EvidenceClaim', refId: claimId })!;
    assert.deepEqual(now.state, record.state);
  });
});

describe('what it refuses to answer', () => {
  it('refuses to say what was true after the last thing it knew', () => {
    const error = throwsCode(
      () =>
        stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId }, {
          recordedBy: `${daysAgo(30)}T00:00:00.000Z`,
          validAt: new Date().toISOString(),
        }),
      'VALID_AFTER_RECORDED',
    );
    assert.match(String(error.message), /future/);
  });

  it('reads a record that does not exist as an empty answer, not an error', () => {
    // Distinct from the refusal above. "Nothing was recorded" is a true answer;
    // the route in front of this is what decides whether the asker may hear it.
    const nothing = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: 'not-a-claim' });
    assert.equal(nothing.state, undefined);
    assert.equal(nothing.applied, 0);
  });

  it('defaults the second axis to the first rather than to now', () => {
    const point = `${daysAgo(45)}T00:00:00.000Z`;
    const asked = stateAsOf(platform.ledger, { refType: 'EvidenceClaim', refId: claimId }, { recordedBy: point });
    // Asking "what did we know on the fourteenth" without saying about when
    // means about the fourteenth. Defaulting to today would quietly mix the axes.
    assert.equal(asked.validAt, point);
  });
});

describe('both axes, side by side', () => {
  it('counts the events that were recorded after they became true', () => {
    const history = temporalHistory(platform.ledger, { refType: 'EvidenceClaim', refId: claimId });
    assert.equal(history.backdated, 1);

    const late = history.steps.find((step) => step.backdated)!;
    assert.equal(late.eventType, 'EVIDENCE_CLAIM_ASSERTED');
    assert.ok(late.backdatedDays >= 89 && late.backdatedDays <= 91, `${late.backdatedDays} days apart`);
    assert.match(history.summary, /already true when the platform learned it/);
  });

  it('marks an event recorded as it happened as exactly that', () => {
    evidence.verifyClaim(asOwner(), claimId, { method: 'Compared against the insurer’s schedule of cover' });

    const history = temporalHistory(platform.ledger, { refType: 'EvidenceClaim', refId: claimId });
    const verified = history.steps.find((step) => step.eventType === 'EVIDENCE_CLAIM_VERIFIED')!;
    // The verification happened when it was written. Only the certificate was old.
    assert.equal(verified.backdated, false);
    assert.equal(verified.backdatedDays, 0);
    assert.equal(verified.validFrom, verified.recordedAt);
    assert.equal(history.backdated, 1, 'still only the certificate');
  });

  it('says plainly when a record has no history at all', () => {
    const history = temporalHistory(platform.ledger, { refType: 'EvidenceClaim', refId: 'not-a-claim' });
    assert.equal(history.steps.length, 0);
    assert.match(history.summary, /No event has been written/);
  });

  it('does not claim an axis a prompt record never had', () => {
    const prompt = evidence.assertClaim(asQS(), {
      kind: 'ACCREDITATION',
      claim: 'ISO 9001 certification current at the date of this submission',
      sourceHash: PROMPT,
    });
    const asserted = platform.ledger
      .eventsForEntity({ refType: 'EvidenceClaim', refId: prompt.id })
      .find((event) => event.eventType === 'EVIDENCE_CLAIM_ASSERTED')!;

    // No issue date was stated, so no second axis is invented. Writing one on
    // every event would change the canonical body of every event for no gain.
    assert.equal(asserted.validFrom, undefined);
    assert.equal(validFromOf(asserted), asserted.timestamp);
    assert.equal(temporalHistory(platform.ledger, { refType: 'EvidenceClaim', refId: prompt.id }).backdated, 0);
  });
});

describe('the doors onto it', () => {
  it('is reachable, and both reads are declared read-only', () => {
    for (const pattern of [
      '/v1/projects/:projectId/entities/:refType/:refId/as-of',
      '/v1/projects/:projectId/entities/:refType/:refId/temporal',
    ]) {
      const route = ROUTES.find((candidate) => candidate.method === 'GET' && candidate.pattern === pattern);
      assert.ok(route, `${pattern} has no route`);
      // A projection that could write would be a second copy of the truth.
      assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('has a console door on the Golden Thread screen', async () => {
    const page = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../frontend/pages/audit.js', import.meta.url), 'utf8'),
    );
    assert.ok(page.includes('/as-of'), 'the as-at read has no door');
    assert.ok(page.includes('/temporal'), 'the history read has no door');
  });
});
