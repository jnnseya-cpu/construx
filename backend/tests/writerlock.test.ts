import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WriterLock, WriterLockHeldError, type LockHolder } from '../src/goldenthread/writerlock.ts';

/**
 * One writer per journal.
 *
 * `docs/STATE.md` said scaling out needs the Postgres design because two
 * containers writing to one volume would interleave events and break the chain.
 * That was true and it was only a note — a second replica would still start, and
 * the corruption is silent until somebody runs a replay to prove something in a
 * dispute. This makes the second replica refuse.
 *
 * The tests that carry the weight are the two that are easy to get wrong: a
 * *live* holder is never taken over however long the test runs, and a *dead* one
 * always is, so a container killed by an OOM does not leave the volume unusable.
 */

let directory: string;
let clock: Date;

/** A lock whose clock the test controls, so staleness is decided not waited for. */
function lockAt(path: string, seconds = 10): WriterLock {
  return new WriterLock(path, { heartbeatSeconds: seconds, now: () => clock });
}

const tick = (seconds: number): void => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-writerlock-'));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('a free volume is claimed, and the claim is legible', () => {
  it('takes a lock nobody holds and records who took it', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'free.writer');
    const lock = lockAt(path);

    const claim = lock.acquire();
    assert.equal(claim.taken, 'FRESH');
    assert.equal(claim.previous, undefined);

    const holder = lock.read()!;
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.writerId, lock.writerId);
    assert.equal(holder.heartbeatAt, '2026-08-28T09:00:00.000Z');
    lock.release();
  });

  it('gives it up on a clean shutdown, so the next boot is not a takeover', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'released.writer');
    const first = lockAt(path);
    first.acquire();
    first.release();
    assert.equal(existsSync(path), false);

    assert.equal(lockAt(path).acquire().taken, 'FRESH');
  });
});

describe('a live writer is never taken over', () => {
  it('refuses the second process, and the refusal names the holder', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'contended.writer');
    const first = lockAt(path);
    first.acquire();

    const second = lockAt(path);
    let raised: WriterLockHeldError | undefined;
    try {
      second.acquire();
    } catch (error) {
      raised = error as WriterLockHeldError;
    }

    assert.ok(raised, 'the second writer should have been refused');
    assert.equal(raised.code, 'JOURNAL_WRITER_LOCK_HELD');
    assert.equal(raised.holder?.writerId, first.writerId);
    // The message has to say what is actually at stake. "Lock held" tells an
    // operator to delete the file.
    assert.match(raised.message, /hashes against the wrong predecessor/);
    assert.match(raised.message, /not with a second replica on the same volume/);
    first.release();
  });

  it('holds through a pause longer than the heartbeat, as long as it keeps beating', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'beating.writer');
    const first = lockAt(path, 10);
    first.acquire();

    // Five minutes of ordinary running. The heartbeat is what keeps the claim
    // alive, and the timer is exercised by calling it directly rather than by
    // making the suite wait five minutes.
    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      tick(10);
      first.beat();
    }

    assert.throws(() => lockAt(path, 10).acquire(), /Another process is writing this journal/);
    first.release();
  });

  it('does not let a departing process delete a lock somebody else now holds', () => {
    // The rolling-deploy defect: the old container's shutdown lands after the
    // new one has taken over, and removing the file would leave the volume
    // unlocked with a live writer on it.
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'overlap.writer');
    const departing = lockAt(path, 10);
    departing.acquire();

    tick(40);
    const arriving = lockAt(path, 10);
    assert.equal(arriving.acquire().taken, 'TAKEN_OVER');

    departing.release();

    assert.equal(existsSync(path), true);
    assert.equal(lockAt(path, 10).read()?.writerId, arriving.writerId);
    arriving.release();
  });
});

describe('a dead writer does not block the volume for ever', () => {
  it('takes over once the heartbeat has gone stale, and reports whose it was', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'stale.writer');
    const dead = lockAt(path, 10);
    dead.acquire();

    // Killed. Nothing beats, and three heartbeats pass.
    tick(31);

    const replacement = lockAt(path, 10);
    const claim = replacement.acquire();
    assert.equal(claim.taken, 'TAKEN_OVER');
    assert.equal(claim.previous?.writerId, dead.writerId);
    // The takeover rewrites the file rather than appending a second claim.
    assert.equal(replacement.read()?.writerId, replacement.writerId);
    replacement.release();
  });

  it('waits the full stale window rather than the heartbeat', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'window.writer');
    const paused = lockAt(path, 10);
    paused.acquire();

    // Two missed heartbeats. A long GC pause, not a dead process — taking over
    // here is what would cause the interleave the lock exists to prevent.
    tick(25);
    assert.throws(() => lockAt(path, 10).acquire(), /Another process is writing this journal/);

    tick(10);
    assert.equal(lockAt(path, 10).acquire().taken, 'TAKEN_OVER');
  });
});

describe('a lock file nobody can read fails safe', () => {
  it('treats unreadable content as held, and ages it out by the file itself', () => {
    clock = new Date();
    const path = join(directory, 'corrupt.writer');
    writeFileSync(path, 'this is not JSON');

    // Held: a lock file nobody can parse is still somebody's claim, and
    // assuming otherwise on a volume with a live writer is the worst answer.
    assert.throws(() => lockAt(path, 10).acquire(), /Another process is writing this journal/);

    const holder = lockAt(path, 10).read()!;
    assert.equal(holder.writerId, 'unknown');
    // Dated by the file's own mtime, so it still ages out rather than blocking
    // the volume permanently.
    assert.ok(Date.parse(holder.heartbeatAt) > 0);
  });

  it('takes over an unreadable lock once it is old enough', () => {
    const path = join(directory, 'old-corrupt.writer');
    writeFileSync(path, '{ truncated');
    clock = new Date(Date.now() + 60_000);
    assert.equal(lockAt(path, 10).acquire().taken, 'TAKEN_OVER');
  });
});

describe('the heartbeat is written whole or not at all', () => {
  it('never leaves a half-written claim for a starting process to read', () => {
    clock = new Date('2026-08-28T09:00:00.000Z');
    const path = join(directory, 'atomic.writer');
    const lock = lockAt(path, 10);
    lock.acquire();

    for (let index = 0; index < 50; index += 1) {
      tick(1);
      lock.beat();
      // Every read between beats parses. A rewrite in place could be caught
      // half-finished; write-and-rename cannot.
      const raw = readFileSync(path, 'utf8');
      const holder = JSON.parse(raw) as LockHolder;
      assert.equal(holder.writerId, lock.writerId);
    }
    // The start time is the acquisition, not the last beat — otherwise a lock
    // held for a week reports as one held for ten seconds.
    assert.equal(lock.read()?.startedAt, '2026-08-28T09:00:00.000Z');
    lock.release();
  });
});
