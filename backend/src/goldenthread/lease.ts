import { hostname } from 'node:os';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { StoreClient } from './pgstore.ts';

/**
 * Which process may extend the chain, decided by the database.
 *
 * `docs/STATE.md` named two things as not done under horizontal scale, and this
 * closes both:
 *
 *   1. *"the writer lock is still load-bearing"* — `writerlock.ts` is a file on
 *      a volume. It is correct for the accident it was built for (a second
 *      replica on the same mount) and it says so, but it is advisory, local, and
 *      wrong the moment two hosts do not share a filesystem or two clocks
 *      disagree. **This lease is held in the same database that holds the
 *      record**, taken with a conditional UPDATE, so exactly one process wins
 *      and the database — not a convention — is what decides.
 *   2. *"promotion is a restart somebody starts rather than an election"* — a
 *      follower already holds the whole record in memory; that is the point of
 *      follower mode. What it lacked was permission to start writing. With the
 *      lease it can take that permission the moment the primary's lease expires,
 *      in-process, without a restart and without anybody being woken.
 *
 * ## The fencing token, and why a lease alone is not enough
 *
 * A lease with an expiry is not sufficient on its own, and the failure is
 * famous: the holder stops the world for a long GC pause, its lease expires, a
 * follower promotes, and then the original process wakes up and carries on
 * writing — believing, correctly as far as it knows, that it still holds the
 * lease. Both processes are now extending one chain.
 *
 * So every acquisition takes a **monotonically increasing token**, and the
 * writer must present it to ship. A promoted process holds a higher token; the
 * paused one wakes holding a lower one and every write it attempts is refused
 * by number rather than by timing. That is what makes this safe rather than
 * merely probable — and it is the property a file lock cannot have, because a
 * file lock has nothing that counts.
 *
 * ## What this is not
 *
 * It is still **one writer**. Two processes extending one hash chain would each
 * need the other's in-memory record, which is the rewrite `pgstore.ts` explains
 * is not worth its cost. What changes is that the single writer is now elected
 * and fenced instead of assumed, and the standby takes over by itself.
 */

/** Seconds a lease is good for after each renewal. */
export const LEASE_TTL_SECONDS = 15;
/** How often the holder renews. Comfortably inside the TTL, so one slow renewal is survivable. */
export const LEASE_RENEW_SECONDS = 5;

export const LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS writer_lease (
  id          text PRIMARY KEY,
  holder      text        NOT NULL,
  token       bigint      NOT NULL,
  host        text        NOT NULL,
  pid         integer     NOT NULL,
  claimed_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
`;

export type LeaseHolder = {
  holder: string;
  token: number;
  host: string;
  pid: number;
  claimedAt: string;
  expiresAt: string;
};

export type LeaseState =
  /** This process holds it. */
  | { role: 'HOLDER'; holder: LeaseHolder }
  /** Somebody else holds it and it has not expired. */
  | { role: 'STANDBY'; holder: LeaseHolder }
  /** Nobody holds it, or the holder's lease has lapsed. It can be taken. */
  | { role: 'FREE'; previous?: LeaseHolder };

function rowToHolder(row: Record<string, unknown>): LeaseHolder {
  return {
    holder: String(row.holder),
    // `bigint` arrives as a string from the wire protocol, which is correct —
    // reading it as a number without saying so is how a token silently stops
    // incrementing at 2^53.
    token: Number(row.token),
    host: String(row.host),
    pid: Number(row.pid),
    claimedAt: new Date(String(row.claimed_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

export class WriterLease {
  readonly #db: StoreClient;
  readonly #id: string;
  readonly #holder = ulid();
  readonly #ttlSeconds: number;
  #token: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** Called when a renewal finds the lease has been taken. */
  #onLost: ((reason: string) => void) | undefined;

  constructor(db: StoreClient, options: { id?: string; ttlSeconds?: number } = {}) {
    this.#db = db;
    this.#id = options.id ?? 'ledger';
    this.#ttlSeconds = options.ttlSeconds ?? LEASE_TTL_SECONDS;
  }

  /** This process's identity in the lease. Unique per process, pids or not. */
  get holderId(): string {
    return this.#holder;
  }

  /** The token this process is fenced by, or undefined where it holds nothing. */
  get token(): number | undefined {
    return this.#token;
  }

  async ensureSchema(): Promise<void> {
    await this.#db.query(LEASE_SCHEMA);
  }

  /** Who holds it now, from the database rather than from memory. */
  async read(): Promise<LeaseState> {
    const { rows } = await this.#db.query<Record<string, unknown>>(
      'SELECT holder, token, host, pid, claimed_at, expires_at, (expires_at <= now()) AS lapsed FROM writer_lease WHERE id = $1',
      [this.#id],
    );
    const row = rows[0];
    if (!row) return { role: 'FREE' };
    const holder = rowToHolder(row);
    if (row.lapsed === true) return { role: 'FREE', previous: holder };
    return holder.holder === this.#holder ? { role: 'HOLDER', holder } : { role: 'STANDBY', holder };
  }

  /**
   * Take the lease if it is free, or extend it if this process already holds it.
   *
   * One statement, conditional, atomic. Two processes racing here both run the
   * same UPDATE; the database serialises them and exactly one sees a row come
   * back. There is no read-then-write window for the second to slip through,
   * which is the whole reason this is not `if (free) take()`.
   *
   * The token increments on every *new* acquisition and stays put on a renewal:
   * a holder that has never lost the lease must not fence itself out of its own
   * in-flight writes.
   */
  async acquire(): Promise<{ taken: boolean; state: LeaseState }> {
    const { rows } = await this.#db.query<Record<string, unknown>>(
      `INSERT INTO writer_lease (id, holder, token, host, pid, claimed_at, expires_at)
       VALUES ($1, $2, 1, $3, $4, now(), now() + ($5 || ' seconds')::interval)
       ON CONFLICT (id) DO UPDATE
         SET holder     = EXCLUDED.holder,
             -- A new holder takes the next token. The same holder renewing
             -- keeps its own, so its outstanding writes stay valid.
             token      = CASE WHEN writer_lease.holder = EXCLUDED.holder
                               THEN writer_lease.token ELSE writer_lease.token + 1 END,
             host       = EXCLUDED.host,
             pid        = EXCLUDED.pid,
             claimed_at = CASE WHEN writer_lease.holder = EXCLUDED.holder
                               THEN writer_lease.claimed_at ELSE now() END,
             expires_at = EXCLUDED.expires_at
         WHERE writer_lease.expires_at <= now() OR writer_lease.holder = EXCLUDED.holder
       RETURNING holder, token, host, pid, claimed_at, expires_at`,
      [this.#id, this.#holder, hostname(), process.pid, String(this.#ttlSeconds)],
    );

    const row = rows[0];
    if (!row) {
      // The conditional did not match: somebody else holds it and their lease
      // is live. Not an error — it is the normal answer for a standby.
      this.#token = undefined;
      return { taken: false, state: await this.read() };
    }
    const holder = rowToHolder(row);
    this.#token = holder.token;
    return { taken: true, state: { role: 'HOLDER', holder } };
  }

  /**
   * Extend the lease this process holds.
   *
   * Returns false where it has been taken — the paused-process case. The caller
   * must stop writing at that point; it is already fenced at the database, but
   * finding out here is what lets it say so rather than fail on its next ship.
   */
  async renew(): Promise<boolean> {
    if (this.#token === undefined) return false;
    const { rowCount } = await this.#db.query(
      `UPDATE writer_lease
          SET expires_at = now() + ($4 || ' seconds')::interval
        WHERE id = $1 AND holder = $2 AND token = $3`,
      [this.#id, this.#holder, String(this.#token), String(this.#ttlSeconds)],
    );
    if (rowCount === 0) {
      this.#token = undefined;
      return false;
    }
    return true;
  }

  /**
   * Give it up on a clean shutdown.
   *
   * Expiring the row rather than deleting it: the next holder's token must be
   * higher than this one's, and a deleted row would start again at 1 — which
   * would un-fence exactly the paused process this exists to fence out.
   */
  async release(): Promise<void> {
    if (this.#token === undefined) return;
    await this.#db.query(
      'UPDATE writer_lease SET expires_at = now() WHERE id = $1 AND holder = $2 AND token = $3',
      [this.#id, this.#holder, String(this.#token)],
    );
    this.#token = undefined;
  }

  /**
   * Refuse a write from a process that no longer holds the lease.
   *
   * Called by the store before it ships. Cheap, in-memory, and it is the
   * *second* line rather than the first — the token on the row is the fence,
   * and this is what turns "the database refused" into a sentence naming who
   * holds the lease now.
   */
  assertHeld(): number {
    if (this.#token === undefined) {
      throw new DomainError(
        'LEDGER_LEASE_LOST',
        'This process no longer holds the writer lease and must not extend the chain. Another host has taken over; ' +
          'this one answers reads and refuses writes until it is restarted.',
        503,
      );
    }
    return this.#token;
  }

  /** Renew on a timer, and say so once when the lease is lost. */
  start(onLost: (reason: string) => void, everySeconds = LEASE_RENEW_SECONDS): void {
    this.#onLost = onLost;
    this.stop();
    this.#timer = setInterval(() => {
      void this.renew().then(
        (held) => {
          if (!held) this.#lost('the lease was taken by another process while this one held it');
        },
        (error: unknown) => {
          // A failed renewal is not a lost lease: the database may simply be
          // unreachable for a moment, and the lease has not expired yet.
          // Treating a network blip as a loss would stop a healthy primary.
          process.stderr.write(`[lease] could not renew and will try again: ${(error as Error).message}\n`);
        },
      );
    }, everySeconds * 1_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #lost(reason: string): void {
    this.stop();
    this.#token = undefined;
    const notify = this.#onLost;
    this.#onLost = undefined;
    notify?.(reason);
  }
}

/**
 * A standby watching for the lease to fall free, and taking it when it does.
 *
 * This is the election. It is deliberately the plainest one that is correct:
 * every standby polls, the database's conditional UPDATE settles the race, and
 * the winner's token fences the loser and the old primary alike. No quorum, no
 * consensus protocol, no third component to operate — because the thing being
 * elected is *one writer against a database that is already the arbiter*, and a
 * Raft implementation here would be a second distributed system to run in order
 * to decide something one UPDATE decides.
 */
export async function tryPromote(
  lease: WriterLease,
  onPromoted: (token: number) => Promise<void> | void,
): Promise<{ promoted: boolean; state: LeaseState }> {
  const state = await lease.read();
  if (state.role === 'STANDBY') return { promoted: false, state };
  if (state.role === 'HOLDER') return { promoted: false, state };

  const { taken, state: after } = await lease.acquire();
  if (!taken) return { promoted: false, state: after };

  // The order matters: the lease is held *before* anything is allowed to write,
  // so a promotion that throws part-way leaves a process holding the lease and
  // refusing writes rather than one writing without it.
  await onPromoted(lease.token!);
  return { promoted: true, state: after };
}
