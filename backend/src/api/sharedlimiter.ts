import { connect, type Socket } from 'node:net';

/**
 * Rate-limit state shared across replicas, spoken to Redis directly.
 *
 * The limiter is a token bucket in a `Map`. One process, that is exactly right.
 * Behind a load balancer with four replicas it is four separate buckets, so the
 * effective limit is four times what the configuration says and a brute-force
 * attempt on the login route gets four times the budget. That is the whole
 * defect: not that the limiter is wrong, but that it is per-process and the
 * deployment is not.
 *
 * Zero runtime dependencies is a settled decision, so this speaks RESP over a
 * socket the same way `messaging/smtp.ts` speaks SMTP. RESP is a smaller and
 * more stable protocol than SMTP and this uses four verbs of it, so a client
 * library and its transitive tree would cost more than it saves.
 *
 * What this deliberately is not: a general Redis client. No pipelining, no pub
 * or sub, no cluster redirection, no reconnect storm control beyond a single
 * retry. It runs one script and reads one array back.
 */

export type BucketVerdict = { allowed: boolean; remaining: number; retryAfter: number };

/**
 * The bucket, as a script, because the read-modify-write has to be atomic.
 *
 * Doing this as GET then SET across the network is a race under exactly the
 * load the limiter exists for: two replicas read the same remaining count and
 * both allow the request. Redis runs a script to completion, so the refill and
 * the decrement cannot interleave.
 *
 * `TIME` rather than a timestamp from the caller: the clocks that matter are
 * the replicas', they disagree, and a bucket refilled against a fast replica's
 * clock hands out tokens nobody has earned.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])

local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now_ms
end

tokens = math.min(capacity, tokens + ((now_ms - ts) * refill_per_ms))

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry_after = math.ceil((1 - tokens) / refill_per_ms / 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, ttl_ms)

return { allowed, math.floor(tokens), retry_after }
`;

function encode(parts: readonly string[]): string {
  // RESP arrays of bulk strings. Lengths are byte counts, not character counts,
  // which matters the moment a key carries a non-ASCII tenant name.
  let out = `*${parts.length}\r\n`;
  for (const part of parts) out += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  return out;
}

class RespError extends Error {
  readonly code = 'LIMITER_BACKEND_UNAVAILABLE';
}

/**
 * A single connection that runs one command at a time.
 *
 * Serialised rather than pipelined because the caller awaits each verdict
 * anyway, and a pipelined client that mismatches replies to requests fails in
 * the least debuggable way available.
 */
class RespConnection {
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  #failure: Error | undefined;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new RespError('Connection closed by the limiter backend')));
  }

  #fail(error: Error): void {
    this.#failure = error;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }

  #drain(): void {
    if (!this.#pending) return;
    const parsed = parse(this.#buffer, 0);
    if (!parsed) return;
    this.#buffer = this.#buffer.subarray(parsed.offset);
    const pending = this.#pending;
    this.#pending = undefined;
    if (parsed.value instanceof Error) pending.reject(parsed.value);
    else pending.resolve(parsed.value);
  }

  send(parts: readonly string[]): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending) return Promise.reject(new RespError('A command is already in flight'));

    return new Promise<unknown>((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#socket.write(encode(parts), (error) => {
        if (error) this.#fail(error);
      });
      // Something has to bound this. A limiter that hangs waiting for a reply
      // holds the request that was asking whether it may proceed.
      setTimeout(() => {
        if (this.#pending) this.#fail(new RespError('The limiter backend did not reply in time'));
      }, 250).unref();
      this.#drain();
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** Parse one RESP value. Returns undefined when more bytes are needed. */
function parse(buffer: Buffer, start: number): { value: unknown; offset: number } | undefined {
  const end = buffer.indexOf('\r\n', start);
  if (end === -1) return undefined;

  const type = String.fromCharCode(buffer[start]!);
  const payload = buffer.toString('utf8', start + 1, end);
  const after = end + 2;

  if (type === '+') return { value: payload, offset: after };
  if (type === '-') return { value: new RespError(payload), offset: after };
  if (type === ':') return { value: Number(payload), offset: after };

  if (type === '$') {
    const length = Number(payload);
    if (length === -1) return { value: null, offset: after };
    if (buffer.length < after + length + 2) return undefined;
    return { value: buffer.toString('utf8', after, after + length), offset: after + length + 2 };
  }

  if (type === '*') {
    const count = Number(payload);
    if (count === -1) return { value: null, offset: after };
    const items: unknown[] = [];
    let offset = after;
    for (let i = 0; i < count; i += 1) {
      const item = parse(buffer, offset);
      if (!item) return undefined;
      items.push(item.value);
      offset = item.offset;
    }
    return { value: items, offset };
  }

  return { value: new RespError(`Unsupported RESP type "${type}"`), offset: after };
}

export type SharedLimiterOptions = {
  /** `redis://host:port`, or `redis://:password@host:port`. */
  url: string;
  connectTimeoutMs?: number;
};

export class SharedLimiter {
  readonly #host: string;
  readonly #port: number;
  readonly #password: string | undefined;
  readonly #connectTimeoutMs: number;
  #connection: RespConnection | undefined;

  constructor(options: SharedLimiterOptions) {
    const url = new URL(options.url);
    this.#host = url.hostname;
    this.#port = url.port === '' ? 6379 : Number(url.port);
    this.#password = url.password === '' ? undefined : decodeURIComponent(url.password);
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 500;
  }

  async #connected(): Promise<RespConnection> {
    if (this.#connection) return this.#connection;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: this.#host, port: this.#port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new RespError('Timed out connecting to the limiter backend'));
      }, this.#connectTimeoutMs);
      timer.unref();
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const connection = new RespConnection(socket);
    if (this.#password !== undefined) await connection.send(['AUTH', this.#password]);
    this.#connection = connection;
    return connection;
  }

  /**
   * Consume one token, across every replica sharing this backend.
   *
   * Throws rather than returning a verdict when the backend is unreachable. The
   * caller decides what an unreachable limiter means, and in this gateway it
   * means deny — an open door during an outage is how brute force gets in.
   */
  async consume(
    key: string,
    options: { max: number; burst: number; windowSeconds: number },
  ): Promise<BucketVerdict> {
    const capacity = options.max + options.burst;
    const refillPerMs = options.max / (options.windowSeconds * 1000);
    // Long enough that an idle bucket is not refilled from scratch while it
    // still has a meaningful deficit, short enough that keys do not accumulate.
    const ttlMs = Math.ceil((capacity / refillPerMs) * 2);

    let connection: RespConnection;
    try {
      connection = await this.#connected();
    } catch (error) {
      this.#connection = undefined;
      throw error instanceof Error ? error : new RespError('The limiter backend is unreachable');
    }

    let reply: unknown;
    try {
      reply = await connection.send([
        'EVAL',
        BUCKET_SCRIPT,
        '1',
        key,
        String(capacity),
        String(refillPerMs),
        String(ttlMs),
      ]);
    } catch (error) {
      // A dropped connection is not a verdict. Discard it so the next call
      // reconnects rather than reusing a socket that is already gone.
      this.#connection?.close();
      this.#connection = undefined;
      throw error instanceof Error ? error : new RespError('The limiter backend failed');
    }

    if (!Array.isArray(reply) || reply.length !== 3) {
      throw new RespError('The limiter backend returned something other than a verdict');
    }

    return {
      allowed: Number(reply[0]) === 1,
      remaining: Number(reply[1]),
      retryAfter: Number(reply[2]),
    };
  }

  close(): void {
    this.#connection?.close();
    this.#connection = undefined;
  }
}
