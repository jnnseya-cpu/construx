import { hostname } from 'node:os';
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from '../core/ids.ts';

/**
 * One writer per journal, enforced.
 *
 * The journal is an append-only hash chain and exactly one process may extend
 * it. Two containers mounting the same volume would interleave their appends,
 * and the result is not a slow platform or a lost event — it is a chain in which
 * every event after the first interleave hashes against a predecessor that is
 * not its predecessor. Nothing verifies, and the failure is silent until
 * somebody runs a replay to prove something in a dispute.
 *
 * `docs/STATE.md` named that as the reason scaling out needs the Postgres design
 * rather than another replica. It was a note; a second replica would still start
 * and still corrupt the volume. This makes the second replica **refuse to
 * start**, which is the only safe answer.
 *
 * ---
 *
 * ## Why a heartbeat rather than a pid
 *
 * The obvious lock records a process id and checks whether it is alive. That is
 * wrong for exactly the case this exists to prevent: two containers have their
 * own pid namespaces, so the second one asks whether pid 1 is alive, finds that
 * it is — itself — and takes the lock.
 *
 * So the holder rewrites the lock file every `heartbeatSeconds`, and a starter
 * decides on the age of that heartbeat rather than on any process identity. A
 * fresh heartbeat means somebody is writing and this process must not. A stale
 * one means the holder died without releasing — a hard kill, an OOM, a node
 * lost — and the lock is taken over, with the previous holder reported so the
 * takeover is visible rather than silent.
 *
 * The stale window is deliberately several heartbeats: a container paused for
 * one GC pause or one slow disk flush has not died, and taking its lock would
 * cause the exact interleave the lock prevents.
 *
 * ## What it does not claim
 *
 * This is correct on a local filesystem and on a normal volume mount. It is
 * **not** correct on NFS with a broken `O_EXCL`, and it is not a distributed
 * lock: two writers whose clocks disagree by more than the stale window could
 * both believe they hold it. Neither of those is the deployment this platform
 * describes, and the honest scaling answer is still Postgres. What this closes
 * is the accident — a second replica started by a scale-up, a rolling deploy
 * that overlaps, a developer pointing a second process at the volume.
 */

export type LockHolder = {
  /** Unique per acquisition. Two processes never share one, pids or not. */
  writerId: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
};

export class WriterLockHeldError extends Error {
  readonly code = 'JOURNAL_WRITER_LOCK_HELD';
  readonly holder: LockHolder | undefined;

  constructor(message: string, holder: LockHolder | undefined) {
    super(message);
    this.name = 'WriterLockHeldError';
    this.holder = holder;
  }
}

const DEFAULT_HEARTBEAT_SECONDS = 10;
/** Three missed heartbeats. One slow flush is not a dead process. */
const STALE_MULTIPLIER = 3;

export class WriterLock {
  readonly #path: string;
  readonly #heartbeatSeconds: number;
  readonly #staleSeconds: number;
  readonly #now: () => Date;
  readonly #writerId = ulid();
  #timer: NodeJS.Timeout | undefined;
  #held = false;

  constructor(
    path: string,
    options: { heartbeatSeconds?: number; staleAfterSeconds?: number; now?: () => Date } = {},
  ) {
    this.#path = path;
    this.#heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.#staleSeconds = options.staleAfterSeconds ?? this.#heartbeatSeconds * STALE_MULTIPLIER;
    this.#now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.#path;
  }

  get writerId(): string {
    return this.#writerId;
  }

  /** Whoever currently claims it, or nothing. Unparseable content reads as claimed. */
  read(): LockHolder | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const holder = JSON.parse(raw) as LockHolder;
      if (typeof holder.heartbeatAt === 'string') return holder;
    } catch {
      /* falls through */
    }
    // A lock file nobody can read is still a lock file. Treated as held by an
    // unknown writer, dated by the file itself, so a corrupt lock fails safe
    // and still ages out rather than blocking the volume for ever.
    let mtime = new Date(0).toISOString();
    try {
      mtime = statSync(this.#path).mtime.toISOString();
    } catch {
      /* the file went away between the read and the stat */
    }
    return { writerId: 'unknown', pid: 0, host: 'unknown', startedAt: mtime, heartbeatAt: mtime };
  }

  /**
   * Claim it, or refuse to start.
   *
   * Returns how the lock was obtained, because taking over from a dead holder
   * is a materially different fact from finding the volume free and a boot log
   * that does not say which is one nobody can diagnose from.
   */
  acquire(): { taken: 'FRESH' | 'TAKEN_OVER'; previous?: LockHolder } {
    mkdirSync(dirname(this.#path), { recursive: true });

    const existing = this.read();
    if (existing) {
      const ageSeconds = (this.#now().getTime() - Date.parse(existing.heartbeatAt)) / 1000;
      if (Number.isNaN(ageSeconds) || ageSeconds < this.#staleSeconds) {
        throw new WriterLockHeldError(
          `Another process is writing this journal: ${existing.host} (pid ${existing.pid}, writer ${existing.writerId}), ` +
            `last heartbeat ${Number.isNaN(ageSeconds) ? 'at an unreadable time' : `${Math.round(ageSeconds)}s ago`}. ` +
            'Two writers on one journal interleave their appends and every event after the first interleave hashes ' +
            'against the wrong predecessor, so this process is refusing to start rather than corrupting the chain. ' +
            'Scale out with the Postgres design, not with a second replica on the same volume.',
          existing,
        );
      }
      this.#write();
      this.#held = true;
      return { taken: 'TAKEN_OVER', previous: existing };
    }

    // Exclusive create, so two processes racing here cannot both succeed.
    try {
      const fd = openSync(this.#path, 'wx');
      try {
        writeSync(fd, this.#body());
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Somebody won the race between the read above and this create.
        throw new WriterLockHeldError(
          'Another process claimed this journal while this one was starting. Only one writer may extend the chain.',
          this.read(),
        );
      }
      throw error;
    }

    this.#held = true;
    return { taken: 'FRESH' };
  }

  /** Refresh the heartbeat. Cheap, and the only thing keeping the claim alive. */
  beat(): void {
    if (!this.#held) return;
    this.#write();
  }

  /** Start beating on a timer. Unref'd so it never holds the process open. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.beat(), this.#heartbeatSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Give it up on a clean shutdown.
   *
   * Only removes a lock this process still holds — a takeover has already
   * rewritten the file, and deleting somebody else's claim on the way out is
   * how a rolling deploy ends up with two writers.
   */
  release(): void {
    this.stop();
    if (!this.#held) return;
    this.#held = false;
    const current = this.read();
    if (current && current.writerId !== this.#writerId) return;
    try {
      unlinkSync(this.#path);
    } catch {
      /* already gone; nothing to do */
    }
  }

  #body(): string {
    const at = this.#now().toISOString();
    const holder: LockHolder = {
      writerId: this.#writerId,
      pid: process.pid,
      host: hostname(),
      startedAt: at,
      heartbeatAt: at,
    };
    return `${JSON.stringify(holder)}\n`;
  }

  /**
   * Rewrite atomically.
   *
   * A heartbeat written in place can be read half-finished by a starting
   * process, which would then read a corrupt lock and treat the live holder as
   * unknown. Write-and-rename makes every read see one whole holder or the
   * previous one.
   */
  #write(): void {
    const at = this.#now().toISOString();
    const existing = this.#held ? this.read() : undefined;
    const holder: LockHolder = {
      writerId: this.#writerId,
      pid: process.pid,
      host: hostname(),
      startedAt: existing?.writerId === this.#writerId ? existing.startedAt : at,
      heartbeatAt: at,
    };
    const temporary = `${this.#path}.${this.#writerId}`;
    writeFileSync(temporary, `${JSON.stringify(holder)}\n`);
    renameSync(temporary, this.#path);
  }
}
