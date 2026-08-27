import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as conflictsModule from '../src/field/conflicts.ts';
import type { SyncOperation } from '../src/field/sync.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The conflict record, and the merge that stops most conflicts happening.
 *
 * The sync engine has always resolved deterministically and reported what it
 * did. What it did not do was *keep* the report. A conflict resolved at push
 * time and returned in the response is invisible the moment the device drops
 * the response — and the device is, by construction, the one on the bad
 * connection. A supervisor's pour record refused for progress regression simply
 * vanished: the work was done, the record was made, and nothing in the platform
 * said it had been discarded.
 *
 * Two things are under test here.
 *
 * **Every conflict becomes a record.** Every resolution has a losing side, so
 * every one of them is written as a `SyncConflict` before anything else
 * happens — including the ones the engine let through.
 *
 * **Disjoint edits merge instead of picking a winner.** Two people editing one
 * record usually edited different parts of it, and picking a winner there
 * throws away a change nobody disagreed with. `MERGED` was in the resolution
 * vocabulary from the first day and nothing could ever produce it.
 */

let platform: Platform;
let seed: SeedResult;
let taskId: string;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asSupervisor = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'WEB' });
const asAgent = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'AI' });

beforeEach(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  taskId = platform.ledger.list(seed.projectId, 'Task')[0]!.refId;
});

const agoIso = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** The task as the server currently holds it. */
function serverTask(): Record<string, unknown> {
  return platform.ledger.require({ refType: 'Task', refId: taskId }).state;
}

/**
 * A device push against a stale base.
 *
 * `baseState` is what the device believed; `nextState` is what it wrote. The
 * hash is deliberately wrong, which is what puts the operation down the
 * conflict path at all.
 */
function push(
  operationId: string,
  nextState: Record<string, unknown>,
  baseState?: Record<string, unknown>,
): ReturnType<Platform['sync']['push']> {
  const operation: SyncOperation = {
    operationId,
    deviceId: 'device-conflict',
    deviceTimestamp: agoIso(2),
    eventType: 'TASK_UPDATED',
    entity: { refType: 'Task', refId: taskId },
    nextState,
    baseStateHash: 'sha256:stale',
    baseState,
    source: 'ANDROID',
  };
  return platform.sync.push(seed.users.pm!.auth, seed.projectId, [operation], `corr-${operationId}`);
}

describe('every conflict leaves a record', () => {
  it('records the one where the server won, which is the one that lost work', () => {
    const before = conflictsModule.conflictPosition(asPM());
    const result = push('op-regress', { ...serverTask(), percentComplete: 1 });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.conflicts[0]?.reason, 'PROGRESS_REGRESSION');
    assert.ok(result.conflicts[0]?.conflictId, 'the conflict was reported but not recorded');

    const after = conflictsModule.conflictPosition(asPM());
    assert.equal(after.open, before.open + 1);
    assert.equal(after.workLost, before.workLost + 1);

    const recorded = after.conflicts.find((entry) => entry.conflictId === result.conflicts[0]!.conflictId)!;
    assert.equal(recorded.status, 'OPEN');
    assert.equal(recorded.autoResolution, 'SERVER_WINS');
    assert.equal(recorded.operationId, 'op-regress');
    assert.equal(recorded.deviceId, 'device-conflict');
    // Both sides kept whole: deciding after the fact means reading what each
    // party actually wrote, not a summary of the difference.
    assert.equal(recorded.deviceState.percentComplete, 1);
    assert.ok(recorded.serverState, 'the server’s own state was not kept');
  });

  it('records a refusal, which loses the device’s work outright', () => {
    const result = platform.sync.push(
      seed.users.pm!.auth,
      seed.projectId,
      [
        {
          operationId: 'op-forbidden',
          deviceId: 'device-conflict',
          deviceTimestamp: agoIso(1),
          eventType: 'HANDOVER_ACCEPTED',
          entity: { refType: 'Task', refId: taskId },
          nextState: { accepted: true },
          source: 'PWA',
        },
      ],
      'corr-forbidden',
    );

    assert.equal(result.conflicts[0]?.reason, 'EVENT_NOT_PERMITTED_OFFLINE');
    const conflictId = result.conflicts[0]?.conflictId;
    assert.ok(conflictId, 'a governance action refused offline left no record of having been attempted');

    const recorded = conflictsModule.syncConflicts(asPM()).find((entry) => entry.conflictId === conflictId)!;
    assert.equal(recorded.autoResolution, 'REJECTED');
    assert.equal(recorded.eventType, 'HANDOVER_ACCEPTED');
  });

  it('records the one where the device won, because the server’s version lost', () => {
    const result = push('op-device-wins', { ...serverTask(), note: 'Rebar cover checked at the north face.' });

    const conflictId = result.conflicts[0]?.conflictId;
    assert.ok(conflictId);
    const recorded = conflictsModule.syncConflicts(asPM()).find((entry) => entry.conflictId === conflictId)!;
    assert.equal(recorded.autoResolution, 'DEVICE_WINS');
    // The write went through — a recorded conflict is not a blocked one.
    assert.deepEqual(result.accepted, ['op-device-wins']);
  });

  it('survives the connection, which is the whole point', () => {
    const result = push('op-durable', { ...serverTask(), percentComplete: 1 });
    const conflictId = result.conflicts[0]!.conflictId!;

    // The device never reads the response. Everything it was told is still here.
    const found = conflictsModule.syncConflicts(asPM()).find((entry) => entry.conflictId === conflictId);
    assert.ok(found, 'the conflict existed only in a payload the device may never have received');
    assert.match(found.message, /already recorded at/);
  });
});

describe('disjoint edits merge rather than picking a winner', () => {
  it('takes the device’s field and leaves the server’s alone', () => {
    const server = serverTask();
    // The base is the server's record as the device last saw it: the same in
    // every respect except the one field the server has since changed. So
    // `percentComplete` is what the server moved, and `note` is what the device
    // moved — and the device's payload leaves `percentComplete` at the base
    // value, because a device that did not touch a field must not be treated as
    // having set it back.
    const base = { ...server, percentComplete: Number(server.percentComplete) - 5 };
    const result = push('op-merge', { ...base, note: 'Formwork struck on the east elevation.' }, base);

    const conflict = result.conflicts[0];
    assert.ok(conflict, 'no conflict was reported at all');
    assert.equal(conflict.resolution, 'MERGED', conflict.message);
    assert.equal(conflict.reason, 'DISJOINT_FIELDS');
    assert.deepEqual(conflict.mergedFields, ['note']);
    assert.deepEqual(result.accepted, ['op-merge']);

    const after = serverTask();
    assert.equal(after.note, 'Formwork struck on the east elevation.');
    // And the field only the server changed still holds the server's value.
    assert.equal(after.percentComplete, server.percentComplete);
  });

  it('refuses to merge when both sides touched the same field', () => {
    const server = serverTask();
    const base = { ...server, note: 'Base note' };
    const result = push('op-same-field', { ...base, note: 'Device note' }, { ...base, note: 'Different base' });

    // Both changed `note` relative to the base, so this is a real disagreement
    // and one of them has to lose.
    assert.notEqual(result.conflicts[0]?.resolution, 'MERGED');
  });

  it('refuses to merge arrays and objects, which is where a merge invents data', () => {
    const server = serverTask();
    const base = { ...server, tags: ['a'], note: 'Base note' };
    // The device changed an array. Concatenating it with the server's would be
    // an ordering neither party asked for.
    const result = push('op-array', { ...base, tags: ['a', 'b'] }, { ...base, note: 'Different base' });
    assert.notEqual(result.conflicts[0]?.resolution, 'MERGED');
  });

  it('does not merge when the device did not send what it was working from', () => {
    // The whole mechanism is optional. Without a base there is no way to tell a
    // field the device changed from one it carried along, so this falls through
    // to exactly the behaviour that existed before.
    const result = push('op-no-base', { ...serverTask(), note: 'No base sent.' });
    assert.notEqual(result.conflicts[0]?.resolution, 'MERGED');
    assert.equal(result.conflicts[0]?.resolution, 'DEVICE_WINS');
  });
});

describe('what a person decides about it', () => {
  function openOne(): string {
    const result = push('op-to-resolve', { ...serverTask(), percentComplete: 1 });
    return result.conflicts[0]!.conflictId!;
  }

  it('confirms the engine, naming who decided and why', () => {
    const conflictId = openOne();
    conflictsModule.resolveSyncConflict(asPM(), {
      conflictId,
      decision: 'KEPT_SERVER',
      reason: 'Spoke to the supervisor; the 1% was a mis-tap on the handset.',
    });

    const recorded = conflictsModule.syncConflicts(asPM()).find((entry) => entry.conflictId === conflictId)!;
    assert.equal(recorded.status, 'RESOLVED');
    assert.equal(recorded.decision, 'KEPT_SERVER');
    assert.equal(recorded.decidedBy, seed.users.pm!.id);
    assert.ok(Date.parse(String(recorded.decidedAt)) > 0);
    assert.equal(conflictsModule.conflictPosition(asPM()).open, 0);
  });

  it('overturns the engine by writing the device’s record, not by annotating it', () => {
    const conflictId = openOne();
    const result = conflictsModule.resolveSyncConflict(asPM(), {
      conflictId,
      decision: 'APPLIED_DEVICE',
      reason: 'The task was descoped; 1% is correct and the higher figure was against the old scope.',
    });

    assert.ok(result.appliedEventId, 'the decision was recorded and the site record left wrong');
    // A resolution that only annotated the conflict would leave the paperwork
    // tidy and the record wrong, which is the wrong way round.
    assert.equal(Number(serverTask().percentComplete), 1);

    const applied = platform.ledger
      .events({ tenantId: seed.tenantId, projectId: seed.projectId })
      .find((event) => event.eventId === result.appliedEventId)!;
    // Under the resolver's identity, not the device's: overturning a refusal
    // means taking responsibility for the write.
    assert.equal(applied.actor.refId, seed.users.pm!.id);
    // And the time the work happened is still the time on site.
    assert.ok(applied.deviceTimestamp);
  });

  it('refuses a resolution with no reason, and a second one entirely', () => {
    const conflictId = openOne();
    throwsCode(
      () => conflictsModule.resolveSyncConflict(asPM(), { conflictId, decision: 'KEPT_SERVER', reason: '   ' }),
      'REASON_REQUIRED',
    );

    conflictsModule.resolveSyncConflict(asPM(), { conflictId, decision: 'KEPT_SERVER', reason: 'Confirmed on site.' });
    const error = throwsCode(
      () =>
        conflictsModule.resolveSyncConflict(asPM(), {
          conflictId,
          decision: 'APPLIED_DEVICE',
          reason: 'Changed my mind.',
        }),
      'ALREADY_RESOLVED',
    );
    assert.match(String(error.message), /somebody's decision|somebody’s decision/);
  });

  it('lets no model choose whose record of the site survives', () => {
    const conflictId = openOne();
    throwsCode(
      () =>
        conflictsModule.resolveSyncConflict(asAgent(), {
          conflictId,
          decision: 'KEPT_SERVER',
          reason: 'Looks like a mis-tap.',
        }),
      'AI_CANNOT_RESOLVE',
    );
    assert.equal(lookupEventType('SYNC_CONFLICT_RESOLVED')?.aiAllowed, false);
  });

  it('does not let the person whose record was refused reinstate it alone', () => {
    // Approval on field execution, not update. The supervisor holds C and U and
    // is precisely the person who would otherwise mark their own homework.
    const conflictId = openOne();
    throwsCode(
      () =>
        conflictsModule.resolveSyncConflict(asSupervisor(), {
          conflictId,
          decision: 'APPLIED_DEVICE',
          reason: 'It was right the first time.',
        }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a conflict that is not on this project', () => {
    throwsCode(
      () =>
        conflictsModule.resolveSyncConflict(asPM(), {
          conflictId: 'not-a-conflict',
          decision: 'KEPT_SERVER',
          reason: 'Nothing to decide.',
        }),
      'NO_SUCH_CONFLICT',
    );
  });
});
