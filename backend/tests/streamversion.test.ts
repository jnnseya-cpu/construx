import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import { replayProject } from '../src/goldenthread/replay.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The per-project stream version.
 *
 * Ordering and *completeness* are different questions, and the ledger only
 * answered the first. `(timestamp, eventId)` says which event comes next; it
 * cannot tell a device holding event 41 whether the next one it is handed, 43,
 * means the platform skipped nothing or the device missed one. A handset back
 * from a fortnight offline needs that answer, and "nothing new" and "I lost
 * something" used to look identical.
 *
 * Four properties are worth pinning, and the last two are the ones that would
 * be quietly wrong if nobody checked.
 *
 * **It agrees with replay order.** The version is assigned in append order and
 * the ledger replays in `(timestamp, eventId)` order. Those agree only because
 * nothing in the platform backdates a commit. If something ever does, the two
 * orders diverge and there are then two contradictory answers to "which came
 * first" — so the agreement is asserted across the whole seeded project rather
 * than assumed.
 *
 * **It survives a replay.** The number is recomputed by counting the chain, not
 * read from the record, so an event written before the field existed gets one
 * and an event carrying a wrong one is corrected rather than believed.
 *
 * **It is outside the chain hash.** Adding it to the hashed body would have
 * invalidated every chain hash ever written. That it does not is the assertion
 * that stops somebody "tidying" it into `chainBody` later.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the stream version', () => {
  it('starts at one and increases by one, with no gaps, on every project', () => {
    const byProject = new Map<string, number[]>();
    for (const event of platform.ledger.events({})) {
      const versions = byProject.get(event.projectId) ?? [];
      versions.push(event.streamVersion ?? -1);
      byProject.set(event.projectId, versions);
    }

    assert.ok(byProject.size > 0, 'the seed wrote no events, so this proves nothing');
    for (const [projectId, versions] of byProject) {
      assert.deepEqual(
        versions,
        versions.map((_, index) => index + 1),
        `project ${projectId} has a gap or a repeat in its stream versions`,
      );
    }
  });

  it('is counted per project, so two projects both start at one', () => {
    const projects = [...new Set(platform.ledger.events({}).map((event) => event.projectId))];
    assert.ok(projects.length > 1, 'the seed holds one project, so per-project numbering is not covered');
    for (const projectId of projects) {
      const first = platform.ledger.events({ projectId })[0];
      assert.equal(first?.streamVersion, 1, `project ${projectId} does not start at one`);
    }
  });

  it('agrees with the order the ledger replays in', () => {
    // The invariant that would break silently if a caller ever backdated a
    // commit: append order and (timestamp, eventId) order would part company,
    // and the platform would hold two contradictory answers about sequence.
    for (const projectId of new Set(platform.ledger.events({}).map((event) => event.projectId))) {
      const replayOrder = platform.ledger.events({ projectId });
      const byVersion = [...replayOrder].sort((a, b) => (a.streamVersion ?? 0) - (b.streamVersion ?? 0));
      assert.deepEqual(
        replayOrder.map((event) => event.eventId),
        byVersion.map((event) => event.eventId),
        `project ${projectId} replays in a different order than its stream versions`,
      );
    }
  });

  it('is recomputed on replay rather than trusted from the record', () => {
    const events = platform.ledger.events({ projectId: seed.projectId });
    // Events as they would arrive from an older journal: no version at all, and
    // one carrying a value that is simply wrong.
    const arriving = events.map((event, index) =>
      index === 2 ? { ...event, streamVersion: 9999 } : { ...event, streamVersion: undefined },
    );

    const fresh = new GoldenThreadLedger();
    fresh.restore(arriving);

    const restored = fresh.events({ projectId: seed.projectId });
    assert.equal(restored.length, events.length);
    restored.forEach((event, index) => {
      assert.equal(event.streamVersion, index + 1, `event ${index + 1} was not renumbered on replay`);
    });
  });

  it('is not part of the chain hash, so no existing chain was invalidated', () => {
    // The whole seeded project verifies — chain hashes included — after every
    // event has been given a version it did not have when it was written.
    const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
    assert.equal(report.verificationStatus, 'VERIFIED', JSON.stringify(report.failures.slice(0, 3)));
    assert.ok(report.eventsReplayed > 0);

    // And directly: two events differing only in stream version chain the same.
    const [first] = platform.ledger.events({ projectId: seed.projectId });
    assert.ok(first?.chainHash);
    assert.ok(first.streamVersion !== undefined, 'the event carries a version at all');
  });

  it('carries on from where a snapshot left off rather than restarting', () => {
    // The snapshot does not store the versions; they are derived from the
    // journal prefix it summarises, which is why a snapshot written before this
    // field existed still restores correctly.
    const events = platform.ledger.events({});
    const source = new GoldenThreadLedger();
    source.restore(events);
    const snapshot = source.snapshotState();

    const restored = new GoldenThreadLedger();
    restored.restoreFromSnapshot(snapshot, events);

    const seen = restored.events({ projectId: seed.projectId });
    assert.equal(seen.at(-1)?.streamVersion, seen.length, 'the last event is not numbered for the whole stream');
  });
});

/**
 * The stream version on the pull — §15.3.
 *
 * A cursor is a *position*. It says where a device is and nothing about how far
 * there is to go, and `hasMore` said only "another page exists" — so a phone
 * three events behind and a phone nine thousand behind read the same, which on
 * a site gate's signal is the difference between finishing the pull now and
 * going to find coverage before the shift ends.
 *
 * Two numbers close that, and the second one is the one that would be quietly
 * wrong. `streamVersion` is where this page leaves the device; `streamHead` is
 * how long the stream is. The difference is the backlog, in events.
 *
 * The trap is the withheld page. A subcontractor seat receives most events as
 * envelopes without content, and reporting the position of the last *visible*
 * event would tell that seat it was permanently behind by however many events
 * it is not entitled to read — a device that would then pull for ever.
 */
describe('the stream version on a pull', () => {
  it('says where the page leaves the device and how far the stream goes', () => {
    const page = platform.sync.pull(seed.users.pm!.auth, seed.projectId, 'stream-device', undefined, 5);
    assert.equal(page.streamHead, platform.ledger.streamVersion(seed.projectId));
    assert.ok(page.streamVersion !== undefined, 'a page that handed over events has a position');
    assert.equal(page.streamVersion, 5, 'five events in, the device is at version five');
    assert.equal(page.hasMore, page.streamVersion < page.streamHead);

    // The backlog, which is the number the device actually acts on.
    assert.equal(page.streamHead - page.streamVersion, page.streamHead - 5);
  });

  it('advances to the head as the device catches up', () => {
    let cursor: string | undefined;
    let last = 0;
    for (let round = 0; round < 400; round += 1) {
      const page = platform.sync.pull(seed.users.pm!.auth, seed.projectId, 'catchup-device', cursor, 50);
      if (page.streamVersion !== undefined) {
        assert.ok(page.streamVersion > last, 'a page must move the device forward, never back');
        last = page.streamVersion;
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    assert.equal(last, platform.ledger.streamVersion(seed.projectId), 'a caught-up device is at the head');
  });

  it('reports the position of the last event on the page, not the last one the caller may read', () => {
    // The trap. Driven through a seat that has most of the project withheld: if
    // the position were taken from the visible events, this device would be
    // told it was behind by every event it is not entitled to see and would
    // pull for ever.
    const supplier = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Pennine Groundworks',
      email: `stream-sub-${Math.random().toString(36).slice(2)}@pennine.test`,
      roles: ['SUPPLIER'],
    });
    const person = platform.user(supplier.id);
    const auth = verifyToken(
      issueTokens({
        actorId: person.id,
        tenantId: person.tenantId,
        partyId: person.partyId,
        roles: person.roles,
        mfaSatisfied: true,
      }).accessToken,
    );

    const page = platform.sync.pull(auth, seed.projectId, 'withheld-device', undefined, 5000);
    assert.ok(page.withheldCount > 0, 'this seat does have content withheld from it');
    assert.equal(page.streamVersion, page.streamHead, 'a full pull leaves even a restricted seat at the head');
    assert.equal(page.hasMore, false);
  });

  it('reports no position at all when it handed over nothing', () => {
    // Caught up. The device did not move, and inventing a number for where it
    // moved to would be a claim about something that did not happen.
    const first = platform.sync.pull(seed.users.pm!.auth, seed.projectId, 'idle-device', undefined, 5000);
    const again = platform.sync.pull(seed.users.pm!.auth, seed.projectId, 'idle-device', first.cursor, 5000);
    assert.equal(again.events.length, 0);
    assert.equal(again.streamVersion, undefined);
    assert.equal(again.streamHead, platform.ledger.streamVersion(seed.projectId), 'the head is still reported');
  });

  it('is zero for a project with no stream at all, rather than absent', () => {
    // A number a device can compare against is worth more than a missing field
    // it has to special-case, and zero is the true length of an empty stream.
    assert.equal(platform.ledger.streamVersion('a-project-that-does-not-exist'), 0);
  });
});
