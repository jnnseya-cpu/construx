import { RespClient, type SharedLimiterOptions } from '../api/sharedlimiter.ts';

/**
 * Identity lockouts shared across replicas, in Redis.
 *
 * `identity/lockout.ts` counts failures against an identity in a `Map`. One
 * process, that is exactly right. Behind a load balancer with four replicas
 * it is four separate counts, so a run spread across them gets four times
 * the failures before any one of them locks — the same multiplied-budget
 * defect the shared rate limiter closed for the per-address limit, on the
 * control that exists because per-address limits are not enough.
 *
 * Same backend, same client, same discipline: the count is a hash under
 * `lock:<subject>` and every change to it is a script, because a read-modify-
 * write across the network is a race under exactly the load a lockout exists
 * for. The scripts return the whole state, so the process that ran one can
 * mirror it into its own map and answer the next synchronous question from
 * there.
 *
 * What this deliberately is not: the source of truth for a request. The
 * in-process map stays the thing every synchronous caller reads; this keeps
 * that map honest across replicas, one round-trip before each verification
 * (`lockout.refresh`) and one after each failure. A backend that cannot be
 * reached leaves the process counting on its own and says so on the position
 * — and the per-address rate limiter, which shares the backend, is already
 * refusing the login route during that outage.
 */

export type SharedLockState = {
  failures: number;
  windowFrom: number;
  lockedUntil?: number;
};

/**
 * One failure. `ARGV`: window ms, lock ms, threshold. Returns the state after
 * it, plus whether this failure was the one that crossed the threshold.
 *
 * `TIME` rather than a caller timestamp, for the reason the limiter gives:
 * the replicas' clocks disagree, and a lock computed against a fast clock
 * lifts early on a slow one.
 */
const RECORD_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local lock_ms = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'failures', 'windowFrom', 'lockedUntil')
local failures = tonumber(state[1]) or 0
local window_from = tonumber(state[2]) or now
local locked_until = tonumber(state[3]) or 0

if locked_until > now then
  return { 1, failures, window_from, locked_until, 0 }
end
if locked_until > 0 or (now - window_from) > window_ms then
  failures = 0
  window_from = now
  locked_until = 0
end

failures = failures + 1
local just_locked = 0
if failures >= threshold then
  locked_until = now + lock_ms
  just_locked = 1
end
redis.call('HSET', key, 'failures', failures, 'windowFrom', window_from, 'lockedUntil', locked_until)
redis.call('PEXPIRE', key, math.max(window_ms, lock_ms) + 1000)
return { locked_until > now and 1 or 0, failures, window_from, locked_until, just_locked }
`;

/** The state as it stands, dropping a subject whose window and lock have both passed. */
const STATE_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', key, 'failures', 'windowFrom', 'lockedUntil')
if state[1] == false then
  return { 0, 0, 0, 0 }
end
local failures = tonumber(state[1]) or 0
local window_from = tonumber(state[2]) or now
local locked_until = tonumber(state[3]) or 0
if locked_until > now then
  return { 1, failures, window_from, locked_until }
end
if locked_until > 0 or (now - window_from) > window_ms then
  redis.call('DEL', key)
  return { 0, 0, 0, 0 }
end
return { 0, failures, window_from, 0 }
`;

const PREFIX = 'lock:';

export class SharedLockouts {
  readonly #client: RespClient;

  constructor(options: SharedLimiterOptions) {
    this.#client = new RespClient(options);
  }

  get host(): string {
    return this.#client.host;
  }

  /** Read one subject's shared state. Absent means free. */
  async state(subject: string, windowMs: number): Promise<SharedLockState | undefined> {
    const reply = await this.#client.call(['EVAL', STATE_SCRIPT, '1', `${PREFIX}${subject}`, String(windowMs)]);
    return decode(reply);
  }

  /** Count one failure atomically. Returns the state after it and whether this one locked. */
  async recordFailure(subject: string, windowMs: number, lockMs: number, threshold: number): Promise<{ state: SharedLockState; justLocked: boolean }> {
    const reply = await this.#client.call([
      'EVAL',
      RECORD_SCRIPT,
      '1',
      `${PREFIX}${subject}`,
      String(windowMs),
      String(lockMs),
      String(threshold),
    ]);
    if (!Array.isArray(reply) || reply.length !== 5) throw new Error('The lockout backend returned something other than a state');
    const state = decode(reply.slice(0, 4))!;
    return { state, justLocked: Number(reply[4]) === 1 };
  }

  async clear(subject: string): Promise<void> {
    await this.#client.call(['DEL', `${PREFIX}${subject}`]);
  }

  /** Every subject the backend holds, with its state. For the operator's view; SCAN, never KEYS. */
  async subjects(windowMs: number): Promise<Array<{ subject: string; state: SharedLockState }>> {
    const found: Array<{ subject: string; state: SharedLockState }> = [];
    let cursor = '0';
    do {
      const reply = await this.#client.call(['SCAN', cursor, 'MATCH', `${PREFIX}*`, 'COUNT', '500']);
      if (!Array.isArray(reply) || reply.length !== 2) throw new Error('The lockout backend returned something other than a scan page');
      cursor = String(reply[0]);
      for (const key of reply[1] as string[]) {
        const subject = key.slice(PREFIX.length);
        const state = await this.state(subject, windowMs);
        if (state) found.push({ subject, state });
      }
    } while (cursor !== '0');
    return found;
  }

  close(): void {
    this.#client.close();
  }
}

/** `[locked, failures, windowFrom, lockedUntil]` from a script, or undefined for a free subject. */
function decode(reply: unknown): SharedLockState | undefined {
  if (!Array.isArray(reply) || reply.length < 4) throw new Error('The lockout backend returned something other than a state');
  const failures = Number(reply[1]);
  const windowFrom = Number(reply[2]);
  const lockedUntil = Number(reply[3]);
  if (failures === 0 && lockedUntil === 0) return undefined;
  return { failures, windowFrom, ...(lockedUntil > 0 ? { lockedUntil } : {}) };
}
