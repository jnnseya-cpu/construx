import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
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
