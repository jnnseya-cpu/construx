import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { readSnapshot, resetSnapshots, snapshotPosition, startSnapshots, stopSnapshots, takeSnapshot, writeSnapshot } from '../src/goldenthread/snapshot.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * A snapshot of the ledger beside the journal, so boot replays only the tail.
 *
 * What is asserted: a ledger restored from a snapshot plus the journal is
 * the ledger that would have been rebuilt from the journal alone — every
 * entity, every chain head, every event; only the events after the snapshot
 * are replayed; a torn, edited, stale or mismatched snapshot is refused, so
 * boot falls back to the full replay rather than coming up on a state the
 * journal does not agree with; and a platform rehydrated from one behaves.
 */

const scratch = mkdtempSync(join(tmpdir(), 'construx-snapshot-'));
let platform: Platform;
let path = '';

const ledgerConfig = config.ledger as unknown as { journalPath: string; snapshotIntervalMinutes: number; snapshotMinEvents: number };
const original = { ...ledgerConfig };

before(async () => {
  platform = new Platform();
  await seedDemoProject(platform);
  path = join(scratch, 'ledger.jsonl.snapshot');
});

after(() => {
  stopSnapshots();
  Object.assign(ledgerConfig, original);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => resetSnapshots());

function sameLedger(a: GoldenThreadLedger, b: GoldenThreadLedger): void {
  assert.equal(b.size, a.size, 'event count');
  assert.deepEqual(b.events().map((event) => event.eventId), a.events().map((event) => event.eventId), 'the same events in the same order');
  const projects = new Set(a.events().map((event) => event.projectId));
  for (const projectId of projects) assert.equal(b.chainHead(projectId), a.chainHead(projectId), `chain head of ${projectId}`);
  const entities = a.entitiesOfType('Project').concat(a.entitiesOfType('Tenant'), a.entitiesOfType('PlatformUser'), a.entitiesOfType('Subscription'));
  assert.ok(entities.length > 0);
  for (const record of entities) {
    const restored = b.get({ refType: record.refType, refId: record.refId })!;
    assert.ok(restored, `${record.refType} ${record.refId} restored`);
    assert.deepEqual(restored.state, record.state);
    assert.equal(restored.stateHash, record.stateHash);
    assert.equal(restored.version, record.version);
    assert.equal(restored.lastEventId, record.lastEventId);
  }
  assert.deepEqual(b.discrepancies(), a.discrepancies());
}

describe('a snapshot restores what a full replay would', () => {
  it('writes the state as at the event count, hashed, and reads it back', async () => {
    const stats = await writeSnapshot(platform.ledger, path);
    assert.equal(stats.events, platform.ledger.size);
    assert.ok(stats.entities > 100, `${stats.entities} entities in the seed`);
    assert.ok(stats.bytes > 10_000);
    const read = readSnapshot(path)!;
    assert.equal(read.state.events, platform.ledger.size);
    assert.equal(read.state.entities.length, stats.entities);
    assert.equal(read.stats.takenAt, stats.takenAt);
  });

  it('rebuilds the ledger from the snapshot with nothing to replay', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const rebuilt = new GoldenThreadLedger();
    const outcome = rebuilt.restoreFromSnapshot(snapshot.state, platform.ledger.events());
    assert.equal(outcome.fromSnapshot, platform.ledger.size);
    assert.equal(outcome.replayed, 0);
    assert.equal(outcome.restored, platform.ledger.size);
    sameLedger(platform.ledger, rebuilt);
  });

  it('replays only the tail written after the snapshot, and the tail verifies against the snapshot state', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const before = platform.ledger.size;
    // Write more after the snapshot: a tenancy, a user, a role change.
    const tenant = platform.createTenant({ legalName: 'After Snapshot Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'After', trialGrant: false, opensOn: 'CREATION' });
    platform.createUser({ tenantId: tenant.tenant.id, name: 'Later Person', email: 'later@after.example', roles: ['PLANNER'] });
    const tail = platform.ledger.size - before;
    assert.ok(tail > 0);

    const rebuilt = new GoldenThreadLedger();
    const outcome = rebuilt.restoreFromSnapshot(snapshot.state, platform.ledger.events());
    assert.equal(outcome.fromSnapshot, before);
    assert.equal(outcome.replayed, tail);
    sameLedger(platform.ledger, rebuilt);
    assert.ok(rebuilt.get({ refType: 'Tenant', refId: tenant.tenant.id }), 'the tenancy written after the snapshot is there');
  });

  it('a platform rehydrated from it knows its people', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const again = new Platform();
    again.ledger.restoreFromSnapshot(snapshot.state, platform.ledger.events());
    const identity = again.rehydrate();
    assert.equal(identity.users, platform.users(platform.tenants()[0]!.id).length + platform.tenants().slice(1).reduce((total, tenant) => total + platform.users(tenant.id).length, 0));
    assert.ok(identity.tenants >= 2);
    // And it extends the chain from where the snapshot left it.
    const project = platform.ledger.events().find((event) => event.eventType === 'PROJECT_CREATED')!;
    const head = again.ledger.chainHead(project.projectId);
    again.createTenant({ legalName: 'Extended Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Extended', trialGrant: false, opensOn: 'CREATION' });
    assert.equal(again.ledger.chainHead(project.projectId), head, 'an unrelated chain is untouched');
    assert.ok(again.ledger.size > platform.ledger.size);
  });
});

describe('a snapshot the journal does not agree with is refused', () => {
  it('when the journal is shorter than the snapshot', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const rebuilt = new GoldenThreadLedger();
    throwsCode(() => rebuilt.restoreFromSnapshot(snapshot.state, platform.ledger.events().slice(0, -5)), 'SNAPSHOT_MISMATCH');
  });

  it('when the journal’s event at the snapshot point is a different event', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const events = platform.ledger.events();
    const swapped = [...events.slice(0, -2), events.at(-1)!, events.at(-2)!];
    const rebuilt = new GoldenThreadLedger();
    throwsCode(() => rebuilt.restoreFromSnapshot(snapshot.state, swapped), 'SNAPSHOT_MISMATCH');
  });

  it('when a chain head in the prefix is not where the snapshot says', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    const events = platform.ledger.events().map((event) => ({ ...event }));
    events[Math.floor(events.length / 2)]!.chainHash = 'edited';
    const rebuilt = new GoldenThreadLedger();
    // Editing an event's chain hash mid-prefix moves the head only if it is
    // the last event of its project; pick the last event of the first project.
    const projectId = events[0]!.projectId;
    const lastOfProject = [...events].reverse().find((event) => event.projectId === projectId)!;
    lastOfProject.chainHash = 'edited-head';
    throwsCode(() => rebuilt.restoreFromSnapshot(snapshot.state, events), 'SNAPSHOT_MISMATCH');
  });

  it('when the ledger already holds something', async () => {
    await writeSnapshot(platform.ledger, path);
    const snapshot = readSnapshot(path)!;
    throwsCode(() => platform.ledger.restoreFromSnapshot(snapshot.state, platform.ledger.events()), 'SNAPSHOT_MISMATCH');
  });

  it('when the file is torn, edited, or of a version this build does not read', async () => {
    await writeSnapshot(platform.ledger, path);
    const whole = readFileSync(path, 'utf8');
    writeFileSync(path, whole.slice(0, Math.floor(whole.length * 0.7)));
    throwsCode(() => readSnapshot(path), 'SNAPSHOT_CORRUPT');
    writeFileSync(path, whole.replace('"version":1', '"version":9'));
    throwsCode(() => readSnapshot(path), 'SNAPSHOT_CORRUPT');
    const lines = whole.split('\n');
    lines[1] = lines[1]!.replace(/"version":(\d+)/, '"version":99');
    writeFileSync(path, lines.join('\n'));
    throwsCode(() => readSnapshot(path), 'SNAPSHOT_CORRUPT');
    assert.equal(readSnapshot(join(scratch, 'nothing.snapshot')), undefined, 'no file is not an error');
  });
});

describe('the timer and the position', () => {
  it('takes one on demand, reports it, and counts what has been written since', async () => {
    // A journal path of its own, so the snapshots the tests above wrote beside
    // `ledger.jsonl` are not the one this position reads.
    Object.assign(ledgerConfig, { journalPath: join(scratch, 'timer-ledger.jsonl'), snapshotIntervalMinutes: 60, snapshotMinEvents: 1000 });
    const before = snapshotPosition(platform.ledger);
    assert.equal(before.configured, true);
    assert.equal(before.current, null);
    const taken = await takeSnapshot(platform.ledger);
    assert.equal(taken.taken, true, taken.because ?? '');
    const position = snapshotPosition(platform.ledger);
    assert.equal(position.current?.events, platform.ledger.size);
    assert.equal(position.eventsSince, 0);
    assert.equal(position.lastTakenAt, taken.stats!.takenAt);
    platform.createTenant({ legalName: 'Since Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Since', trialGrant: false, opensOn: 'CREATION' });
    assert.ok(snapshotPosition(platform.ledger).eventsSince > 0);
    const stop = startSnapshots(platform.ledger);
    assert.equal(snapshotPosition(platform.ledger).enabled, true);
    stop();
    assert.equal(snapshotPosition(platform.ledger).enabled, false);
  });

  it('refuses with no journal, since there is nothing to shorten', async () => {
    Object.assign(ledgerConfig, { journalPath: '' });
    const outcome = await takeSnapshot(platform.ledger);
    assert.equal(outcome.taken, false);
    assert.match(outcome.because ?? '', /No journal/);
    assert.equal(snapshotPosition(platform.ledger).configured, false);
    startSnapshots(platform.ledger)();
    assert.equal(snapshotPosition(platform.ledger).enabled, false);
  });
});
