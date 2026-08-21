import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { after, describe, it } from 'node:test';
import { SharedLimiter } from '../src/api/sharedlimiter.ts';

/**
 * Rate-limit state shared across replicas.
 *
 * The limiter is a token bucket in a `Map`. One process, that is right. Four
 * replicas behind a load balancer are four separate buckets, so the configured
 * limit is multiplied by the replica count — and the login route, which carries
 * the tightest limit precisely because it is the brute-force surface, hands out
 * four times the budget.
 *
 * Two things need proving and they need proving differently. The bucket
 * arithmetic runs inside Redis as a script, so it is exercised against a real
 * `redis-server` — a fake that reimplements the Lua in JavaScript would be
 * testing the fake. The failure paths cannot be produced by a healthy server at
 * all, so those use a socket that misbehaves deliberately.
 *
 * **The run starts its own Redis.** These five tests skipped in every run for
 * want of a server, which meant the bucket arithmetic — a security control —
 * was verified nowhere. `redis-server` is a binary, not a dependency: nothing
 * imports it, `package.json` does not name it, and the platform still boots with
 * no `node_modules`. So the test starts one on an ephemeral port, in memory with
 * persistence off, and kills it afterwards. Where the binary is genuinely
 * absent the group still **skips loudly** rather than passing, because a limiter
 * test that quietly reports success on a machine with no backend is worse than
 * no test: it is a green tick against an unexercised security control.
 */

/** A port nobody is on: bound, read, released. */
async function freePort(): Promise<number> {
  const probe = await listening(() => {});
  const found = port(probe);
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

/**
 * Start a server this run owns, unless the environment points at one.
 *
 * `TEST_REDIS_URL` wins where it is set, so CI can aim these at whatever it
 * already runs. Otherwise the process here is ours: no persistence, no config
 * file, and a port that was free a moment ago.
 */
async function startRedis(): Promise<{ url: string; child?: ChildProcess } | null> {
  if (process.env.TEST_REDIS_URL) {
    const url = process.env.TEST_REDIS_URL;
    return (await reachable(url)) ? { url } : null;
  }

  const chosen = await freePort();
  const child = spawn(
    'redis-server',
    ['--port', String(chosen), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'],
    { stdio: 'ignore' },
  );

  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });

  const url = `redis://127.0.0.1:${chosen}`;
  // Redis is listening within a few milliseconds; the loop is for a slow or
  // loaded machine, and gives up rather than hanging the suite.
  for (let attempt = 0; attempt < 40 && !spawnFailed; attempt += 1) {
    if (await reachable(url)) return { url, child };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGKILL');
  return null;
}

/**
 * Started at module scope, not in `before`.
 *
 * `it(name, { skip })` reads the option when the test is *declared*, which is
 * while the module body runs — before any `before` hook. Computing this in a
 * hook left every Redis test permanently skipped while reporting success, which
 * is the exact failure this file is written to avoid.
 */
const backend = await startRedis();
const available = backend !== null;
const REDIS_URL = backend?.url ?? 'redis://127.0.0.1:6399';
if (!available) {
  process.stdout.write(
    '# SKIPPED: no redis-server binary and no reachable TEST_REDIS_URL. ' +
      "The shared limiter's arithmetic is NOT verified in this run.\n",
  );
}
after(() => backend?.child?.kill('SIGTERM'));

describe('the bucket, against a real Redis', () => {
  const limiter = new SharedLimiter({ url: REDIS_URL });

  after(() => limiter.close());

  const key = (name: string) => `test:${name}:${process.pid}:${Date.now()}`;

  it('allows up to capacity and then refuses', { skip: !available }, async () => {
    const k = key('capacity');
    // Capacity is max + burst. A long window makes the refill negligible over
    // the handful of milliseconds this loop takes, so the count is the test.
    const options = { max: 3, burst: 2, windowSeconds: 3600 };

    const verdicts = [];
    for (let i = 0; i < 6; i += 1) verdicts.push(await limiter.consume(k, options));

    assert.deepEqual(
      verdicts.map((v) => v.allowed),
      [true, true, true, true, true, false],
      'expected five tokens then a refusal',
    );
  });

  it('counts the same bucket from two connections, which is the entire point', { skip: !available }, async () => {
    const k = key('replicas');
    const options = { max: 2, burst: 0, windowSeconds: 3600 };

    // Two clients stand in for two replicas. Against per-process buckets both
    // would be allowed twice; against a shared one they share the two tokens.
    const replicaA = new SharedLimiter({ url: REDIS_URL });
    const replicaB = new SharedLimiter({ url: REDIS_URL });
    try {
      assert.equal((await replicaA.consume(k, options)).allowed, true);
      assert.equal((await replicaB.consume(k, options)).allowed, true);
      assert.equal((await replicaA.consume(k, options)).allowed, false, 'the second replica had its own bucket');
      assert.equal((await replicaB.consume(k, options)).allowed, false);
    } finally {
      replicaA.close();
      replicaB.close();
    }
  });

  it('keeps one key from spending another key’s tokens', { skip: !available }, async () => {
    const options = { max: 1, burst: 0, windowSeconds: 3600 };
    const a = key('tenant-a');
    const b = key('tenant-b');

    assert.equal((await limiter.consume(a, options)).allowed, true);
    assert.equal((await limiter.consume(a, options)).allowed, false);
    // Keys are tenant-aware so one tenant cannot exhaust another's capacity.
    assert.equal((await limiter.consume(b, options)).allowed, true);
  });

  it('reports a retry-after a caller can act on', { skip: !available }, async () => {
    const k = key('retry');
    const options = { max: 1, burst: 0, windowSeconds: 60 };

    await limiter.consume(k, options);
    const refused = await limiter.consume(k, options);

    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfter > 0, 'a refusal with no retry-after tells the caller nothing');
    assert.ok(refused.retryAfter <= 60, `retryAfter ${refused.retryAfter} exceeds the window`);
  });

  it('refills over time rather than staying empty', { skip: !available }, async () => {
    const k = key('refill');
    // 200 per second, so a token is back roughly every 5ms.
    const options = { max: 200, burst: 0, windowSeconds: 1 };

    // Drained by draining, not by counting. Two hundred sequential round-trips
    // take about thirty milliseconds, in which six tokens refill — so consuming
    // exactly `max` leaves the bucket non-empty and the fixture, not the code,
    // is what fails. Take tokens until one is refused.
    let drained = false;
    for (let i = 0; i < 400 && !drained; i += 1) {
      drained = !(await limiter.consume(k, options)).allowed;
    }
    assert.ok(drained, 'the bucket never ran out, so the limit is not being enforced at all');

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await limiter.consume(k, options)).allowed, true, 'the bucket never refilled');
  });
});

/**
 * The failure paths. A healthy server cannot produce these, so they are
 * produced deliberately — and every one of them must surface as a thrown error,
 * because the caller in `middleware.ts` turns a throw into a denial and an
 * accidental resolution into an open door.
 */
describe('when the backend misbehaves', () => {
  it('throws rather than resolving when nothing is listening', async () => {
    // Port 1 is reserved and nothing binds it.
    const limiter = new SharedLimiter({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 200 });
    await assert.rejects(() => limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }));
    limiter.close();
  });

  it('throws on an error reply instead of treating it as a verdict', async () => {
    const server = await listening((socket) => socket.write('-ERR unknown command\r\n'));
    const limiter = new SharedLimiter({ url: urlFor(server) });
    try {
      await assert.rejects(() => limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }));
    } finally {
      limiter.close();
      server.close();
    }
  });

  it('throws when the reply is not a verdict at all', async () => {
    // The shape matters: a caller that read `reply[0]` off a string would get
    // undefined, and `Number(undefined) === 1` is false, so it would deny —
    // correct by luck. This makes it correct on purpose.
    const server = await listening((socket) => socket.write('+OK\r\n'));
    const limiter = new SharedLimiter({ url: urlFor(server) });
    try {
      await assert.rejects(() => limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }));
    } finally {
      limiter.close();
      server.close();
    }
  });

  it('throws when the connection drops mid-command', async () => {
    const server = await listening((socket) => socket.destroy());
    const limiter = new SharedLimiter({ url: urlFor(server) });
    try {
      await assert.rejects(() => limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }));
    } finally {
      limiter.close();
      server.close();
    }
  });

  it('throws rather than hanging when the server never replies', async () => {
    // A limiter that waits forever holds the request that was asking whether it
    // may proceed, which is a denial of service the limiter caused itself.
    const server = await listening(() => {});
    const limiter = new SharedLimiter({ url: urlFor(server) });
    try {
      await assert.rejects(() => limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }));
    } finally {
      limiter.close();
      server.close();
    }
  });

  it('sends AUTH before anything else when the url carries a password', async () => {
    const received: string[] = [];
    const server = await listening((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk.toString('utf8'));
        socket.write(':1\r\n');
      });
    });
    const limiter = new SharedLimiter({ url: `redis://:s3cret@127.0.0.1:${port(server)}` });
    try {
      await limiter.consume('k', { max: 1, burst: 0, windowSeconds: 60 }).catch(() => undefined);
      assert.ok(received[0]?.includes('AUTH'), 'the first command was not AUTH');
      assert.ok(received[0]?.includes('s3cret'), 'the password was not sent');
    } finally {
      limiter.close();
      server.close();
    }
  });
});

function listening(onConnection: (socket: import('node:net').Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function port(server: Server): number {
  return (server.address() as { port: number }).port;
}

function urlFor(server: Server): string {
  return `redis://127.0.0.1:${port(server)}`;
}
