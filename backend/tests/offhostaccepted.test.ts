import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { readiness } from '../src/api/readiness.ts';
import { backupStanding } from '../src/ops/backup.ts';

/**
 * A decision recorded, not a warning silenced.
 *
 * Missing off-host backup is reported as blocking, and it should be: the record
 * is the product and a copy on the same disk survives a bad deploy and nothing
 * else. But three separate things then say so every day — the readiness screen,
 * the watch rule and `deploy/env-check.sh` — and none of them could tell "nobody
 * has looked at this" from "somebody looked at it and decided". An operator who
 * has decided is left with a red line they cannot answer, and a warning nobody
 * can answer is one everybody learns to scroll past, taking the next one with
 * it.
 *
 * `BACKUP_OFFHOST_ACCEPTED` is the answer. What it must never become is a way
 * to make the platform claim something untrue, so the whole of this file is
 * about what does *not* change: the state, the sentence about a lost volume,
 * and the fact that no copy exists anywhere.
 */

const backup = config.backup as unknown as { offhostAccepted: string };
const objectStore = config.objectStore as unknown as { endpoint: string; bucket: string };

const original = { accepted: backup.offhostAccepted, endpoint: objectStore.endpoint, bucket: objectStore.bucket };

afterEach(() => {
  backup.offhostAccepted = original.accepted;
  objectStore.endpoint = original.endpoint;
  objectStore.bucket = original.bucket;
});

function offhost(): { critical: boolean; state: string; detail: string } {
  const entry = readiness().capabilities.find((capability) => capability.key === 'backup.offhost');
  assert.ok(entry, 'the off-host backup capability is gone from readiness');
  return entry;
}

describe('running without an off-host backup, recorded', () => {
  it('blocks while nobody has said anything', () => {
    objectStore.endpoint = '';
    objectStore.bucket = '';
    backup.offhostAccepted = '';

    const entry = offhost();
    assert.equal(entry.critical, true);
    assert.equal(entry.state, 'NOT_SET');
    assert.ok(readiness().blocking.includes('Off-host backup'), 'an unconsidered gap stopped being reported as one');
  });

  it('stops blocking once the decision is written down, and still reports the risk', () => {
    objectStore.endpoint = '';
    objectStore.bucket = '';
    backup.offhostAccepted = 'Pre-launch, no customer records yet; bucket before go-live.';

    const entry = offhost();
    assert.equal(entry.critical, false, 'the answered question is still being asked');
    // The three things that must not change. An acceptance is a statement about
    // who is being asked, never about what is true.
    assert.equal(entry.state, 'NOT_SET', 'an accepted risk was reported as configured');
    assert.match(entry.detail, /the record exists on this host only|on this host only/i);
    assert.match(entry.detail, /no copy is made anywhere/, 'the detail lets a reader think something is being backed up');
    assert.match(entry.detail, /Pre-launch, no customer records yet/, 'the acceptance is not shown in the operator’s own words');
    assert.ok(!readiness().blocking.includes('Off-host backup'));
  });

  it('is not a way to dress an empty decision up as one', () => {
    // Whitespace is not a reason. An acceptance with nothing in it is exactly
    // the flag-flip this exists to avoid being.
    objectStore.endpoint = '';
    objectStore.bucket = '';
    backup.offhostAccepted = '   ';

    assert.equal(offhost().critical, true);
  });

  it('changes nothing where a store is actually configured', () => {
    objectStore.endpoint = 'https://example.r2.cloudflarestorage.com';
    objectStore.bucket = 'construx-record';
    backup.offhostAccepted = 'should be ignored entirely';

    const entry = offhost();
    assert.equal(entry.critical, true, 'a configured store stopped being treated as critical');
    assert.ok(!entry.detail.includes('should be ignored entirely'), 'an acceptance leaked onto a configured store');
  });
});

describe('the watch rule declines to judge rather than passing', () => {
  it('does not fire, and does not report a backup that does not exist', () => {
    objectStore.endpoint = '';
    objectStore.bucket = '';
    backup.offhostAccepted = 'Pre-launch, no customer records yet.';

    const standing = backupStanding();
    // Not judged rather than not breached. A green light would be the platform
    // saying a copy exists somewhere, and none does.
    assert.equal(standing.judged, false, 'the rule passed an assessment on a backup that is not happening');
    assert.equal(standing.breached, false);
    assert.match(standing.detail, /no object store is configured/);
    assert.match(standing.detail, /accepted/);
  });
});
