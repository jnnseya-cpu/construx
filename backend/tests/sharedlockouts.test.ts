import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { SharedLimiter } from '../src/api/sharedlimiter.ts';
import { config } from '../src/config.ts';
import * as lockout from '../src/identity/lockout.ts';
import { SharedLockouts } from '../src/identity/sharedlockouts.ts';

/**
 * Identity lockouts shared across replicas.
 *
 * The lockout counts failures against an identity in a map. Four replicas
 * behind a load balancer are four maps, so a run spread across them gets four
 * times the failures before any one of them locks — on the control that
 * exists because per-address limits are not enough. With a backend attached
 * the map is a mirror of one count in Redis.
 *
 * The arithmetic runs inside Redis as a script, so it is exercised against a
 * real `redis-server`, started by this run the way the limiter's suite starts
 * one; where the binary is absent the group skips loudly rather than passing.
 * The fallback path cannot be produced by a healthy server, so it uses a port
 * nobody is on.
 */

async function freePort(): Promise<number> {
  const probe = await new Promise<Server>((resolve) => {
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const found = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return found;
}

async function reachable(url: string): Promise<boolean> {
  const limiter = new SharedLimiter({ url, connectTimeoutMs: 300 });
  try {
    await limiter.consume(`probe:${Date.now()}`, { max: 10, burst: 0, windowSeconds: 60 });
    return true;
  } catch {
    return false;
  } finally {
    limiter.close();
  }
}

async function startRedis(): Promise<{ url: string; child?: ChildProcess } | null> {
  if (process.env.TEST_REDIS_URL) {
    const url = process.env.TEST_REDIS_URL;
    return (await reachable(url)) ? { url } : null;
  }
  const chosen = await freePort();
  const child = spawn('redis-server', ['--port', String(chosen), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });
  const url = `redis://127.0.0.1:${chosen}`;
  for (let attempt = 0; attempt < 40 && !spawnFailed; attempt += 1) {
    if (await reachable(url)) return { url, child };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  return null;
}

const backend = await startRedis();
const available = backend !== null;
const REDIS_URL = backend?.url ?? 'redis://127.0.0.1:6399';
if (!available) {
  process.stdout.write('# SKIPPED: no redis-server binary and no reachable TEST_REDIS_URL. The shared lockout arithmetic is NOT verified in this run.\n');
}
after(() => backend?.child?.kill('SIGTERM'));

const subject = (name: string) => `test:${name}:${process.pid}:${Date.now()}`;

/** Wait for the module's fire-and-forget pushes to land. */
async function settled(expectedRoundTrips: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && lockout.sharedLockoutState().roundTrips < expectedRoundTrips; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the count, against a real Redis', () => {
  const shared = new SharedLockouts({ url: REDIS_URL });
  after(() => shared.close());

  it('locks on the failure that crosses the threshold, once, and clears', { skip: !available }, async () => {
    const who = subject('threshold');
    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1) outcomes.push(await shared.recordFailure(who, 60_000, 60_000, 4));
    assert.deepEqual(outcomes.map((outcome) => outcome.state.lockedUntil !== undefined), [false, false, false, true, true]);
    assert.deepEqual(outcomes.map((outcome) => outcome.justLocked), [false, false, false, true, false], 'the crossing failure alone reports the transition');
    assert.equal(outcomes[4]!.state.failures, 4, 'a failure while locked is not counted');
    const state = await shared.state(who, 60_000);
    assert.equal(state?.failures, 4);
    assert.ok((state?.lockedUntil ?? 0) > Date.now());
    await shared.clear(who);
    assert.equal(await shared.state(who, 60_000), undefined);
  });

  it('lifts the lock by itself, and starts the count afresh', { skip: !available }, async () => {
    const who = subject('lifts');
    for (let attempt = 0; attempt < 2; attempt += 1) await shared.recordFailure(who, 60_000, 200, 2);
    assert.ok((await shared.state(who, 60_000))?.lockedUntil, 'locked');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await shared.state(who, 60_000), undefined, 'the lock lifted and the slate is clean');
    const next = await shared.recordFailure(who, 60_000, 200, 2);
    assert.equal(next.state.failures, 1, 'a lock that lifted and left the count at the threshold would re-lock on one mistake');
  });

  it('forgets failures older than the window', { skip: !available }, async () => {
    const who = subject('window');
    await shared.recordFailure(who, 150, 60_000, 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = await shared.recordFailure(who, 150, 60_000, 10);
    assert.equal(later.state.failures, 1);
  });

  it('lists every subject it holds', { skip: !available }, async () => {
    const who = subject('listed');
    await shared.recordFailure(who, 60_000, 60_000, 1);
    const held = await shared.subjects(60_000);
    assert.ok(held.some((entry) => entry.subject === who && entry.state.lockedUntil !== undefined));
  });
});

describe('the module, mirroring the shared count', () => {
  const originalAuth = { ...config.auth };
  afterEach(() => {
    Object.assign(config.auth as object, originalAuth);
    lockout.attachShared(undefined);
    lockout.reset();
  });

  it('a second replica sees the first replica’s failures, which is the entire point', { skip: !available }, async () => {
    Object.assign(config.auth as object, { maxIdentityFailures: 3, failureWindowMinutes: 5, lockoutMinutes: 5 });
    const who = subject('replicas');
    // Replica A: this process, with the backend attached.
    lockout.attachShared(new SharedLockouts({ url: REDIS_URL }));
    lockout.resetSharedTallies();
    lockout.recordFailure(who);
    lockout.recordFailure(who);
    await settled(2);
    assert.equal(lockout.lockState(who).failures, 2);

    // Replica B: a process that has never heard of this subject. Before it
    // judges anything it refreshes, and it sees two failures it did not count.
    lockout.reset();
    assert.equal(lockout.lockState(who).failures, 0, 'a fresh map knows nothing');
    await lockout.refresh(who);
    assert.equal(lockout.lockState(who).failures, 2, 'the shared count came in');
    const third = lockout.recordFailure(who);
    assert.equal(third.locked, true, 'the third failure, on a different replica, locked the identity');
    assert.equal(third.justLocked, true);
    await settled(4);

    // Replica A, refreshing, is locked too.
    lockout.reset();
    await lockout.refresh(who);
    assert.equal(lockout.lockState(who).locked, true);
    assert.equal(lockout.sharedLockoutState().backend, 'redis');
    assert.equal(lockout.sharedLockoutState().fallbacks, 0);

    // A successful sign-in on any replica clears everywhere.
    lockout.clearFailures(who);
    await settled(6);
    lockout.reset();
    await lockout.refresh(who);
    assert.equal(lockout.lockState(who).locked, false);
    assert.equal(lockout.lockState(who).failures, 0);
  });

  it('the operator’s view lists locks held by other replicas', { skip: !available }, async () => {
    Object.assign(config.auth as object, { maxIdentityFailures: 1, failureWindowMinutes: 5, lockoutMinutes: 5 });
    const who = subject('operator');
    const other = new SharedLockouts({ url: REDIS_URL });
    await other.recordFailure(who, 300_000, 300_000, 1);
    other.close();
    lockout.attachShared(new SharedLockouts({ url: REDIS_URL }));
    assert.equal(lockout.lockedSubjects().some((entry) => entry.subject === who), false, 'nothing local');
    await lockout.refreshAll();
    assert.equal(lockout.lockedSubjects().some((entry) => entry.subject === who), true, 'the other replica’s lock is on the list');
  });

  it('counts alone, and says so, when the backend cannot be reached', async () => {
    Object.assign(config.auth as object, { maxIdentityFailures: 2, failureWindowMinutes: 5, lockoutMinutes: 5 });
    lockout.attachShared(new SharedLockouts({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 200 }));
    lockout.resetSharedTallies();
    const who = subject('alone');
    await lockout.refresh(who);
    assert.equal(lockout.sharedLockoutState().fallbacks, 1);
    assert.ok(lockout.sharedLockoutState().lastError);
    lockout.recordFailure(who);
    const second = lockout.recordFailure(who);
    assert.equal(second.locked, true, 'the local count still locks');
    for (let attempt = 0; attempt < 100 && lockout.sharedLockoutState().fallbacks < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(lockout.sharedLockoutState().fallbacks, 3, 'each push that could not land is counted');
    assert.equal(lockout.sharedLockoutState().backend, 'redis');
  });

  it('is the map alone with nothing attached, and the position says process', () => {
    lockout.attachShared(undefined);
    assert.equal(lockout.sharedLockoutState().backend, 'process');
    lockout.recordFailure('local-only');
    assert.equal(lockout.lockState('local-only').failures, 1);
  });
});

/**
 * Replies that come back in the wrong order.
 *
 * Two failures in quick succession are two round-trips in flight at once, and
 * nothing guarantees the first one answers first — a retried connection, an
 * uneven event loop, a slow replica. Against a real Redis the ordering is
 * usually right and occasionally not, which is the worst kind of defect to own:
 * it passes locally and lets an attacker through in production. So the backend
 * here answers deliberately backwards, on a stub rather than a server, and the
 * assertion is deterministic.
 *
 * What must not happen is the mirror going *backwards*. A reply carrying one
 * failure landing after a reply carrying two would leave the replica believing
 * the identity has one failure against it, on the control that exists precisely
 * for a burst of attempts.
 */
describe('the mirror, when the backend answers out of order', () => {
  const originalAuth = { ...config.auth };
  afterEach(() => {
    Object.assign(config.auth as object, originalAuth);
    lockout.attachShared(undefined);
    lockout.reset();
  });

  /** A backend whose replies are released by hand, in whatever order the test wants. */
  function stub() {
    const pending: Array<() => void> = [];
    let count = 0;
    const backend = new SharedLockouts({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 50 });
    Object.assign(backend, {
      recordFailure: (subject: string) => {
        count += 1;
        const mine = count;
        return new Promise((resolve) => {
          pending.push(() =>
            resolve({ state: { subject, failures: mine, windowFrom: Date.now() }, justLocked: false }),
          );
        });
      },
      clear: () => Promise.resolve(),
      state: () => Promise.resolve(undefined),
    });
    return { backend, release: (index: number) => pending[index]?.(), settle: async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    } };
  }

  it('keeps the later count when an earlier reply arrives after it', async () => {
    Object.assign(config.auth as object, { maxIdentityFailures: 3, failureWindowMinutes: 5, lockoutMinutes: 5 });
    const { backend, release, settle } = stub();
    lockout.attachShared(backend);
    lockout.recordFailure('out-of-order');
    lockout.recordFailure('out-of-order');

    // The second exchange answers first, then the first — the order that used
    // to leave the map reporting one failure where two had been made.
    release(1);
    await settle();
    release(0);
    await settle();

    assert.equal(lockout.lockState('out-of-order').failures, 2, 'the stale reply must not lower the count');
    backend.close();
  });

  it('does not let a failure reply resurrect a count a successful sign-in cleared', async () => {
    Object.assign(config.auth as object, { maxIdentityFailures: 3, failureWindowMinutes: 5, lockoutMinutes: 5 });
    const { backend, release, settle } = stub();
    lockout.attachShared(backend);
    lockout.recordFailure('cleared');
    // The person proves who they are while the failure is still in flight.
    lockout.clearFailures('cleared');
    await settle();
    release(0);
    await settle();

    assert.equal(lockout.lockState('cleared').failures, 0, 'the clear is the later word and stands');
    backend.close();
  });
});
