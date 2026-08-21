import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GoldenThreadEvent } from './types.ts';

/**
 * Durability for the ledger.
 *
 * The Golden Thread is already an append-only, hash-chained log. The journal is
 * that same log on disk, one JSON object per line, and nothing more: no second
 * schema, no index, no serialisation format to keep in step. Restoring is
 * replaying, which the platform already does and already tests.
 *
 * ---
 *
 * **Write-ahead, not write-behind.** The event is appended and flushed *before*
 * the ledger mutates anything in memory. If the disk write fails, `commit()`
 * throws and no state changed — the alternative acknowledges a commit that is
 * not durable, and the caller has already told somebody their payment notice
 * was issued.
 *
 * That ordering is why this is not a `subscribe()` projection. Subscribers run
 * after the commit and their failures are deliberately swallowed, which is
 * correct for a projection and exactly wrong for durability.
 *
 * **Synchronous by construction.** `commit()` is synchronous and is called from
 * several hundred places; making it async to await a write would be a rewrite
 * of the entire domain layer to buy nothing. `writeSync` + `fsyncSync` keep the
 * signature and cost a flush per event, which is the right trade for a workload
 * measured in events per minute rather than per microsecond.
 *
 * **A crash mid-write leaves a torn last line.** That is expected, not
 * corruption: the process died between the write and the flush completing. The
 * reader detects an unparseable final line, stops there, and reports it. Any
 * *earlier* line failing to parse is real corruption and refuses to load,
 * because silently skipping an event in a hash chain produces a record that
 * verifies against nothing.
 */

export type JournalStats = {
  path: string;
  events: number;
  bytes: number;
  /** A torn final line, dropped on load. Zero in a clean shutdown. */
  truncated: boolean;
};

/**
 * A line-delimited durable log of anything JSON-serialisable.
 *
 * `Journal` is the ledger's; `RecordJournal` is the same mechanism for records
 * that are deliberately not Golden Thread events — the ACU wallet's entries,
 * which are a separate double-entry ledger by a settled decision and would
 * become a second source of truth for spend if they were folded into the
 * chain. Same file format, same write-ahead ordering, same torn-tail handling,
 * different file.
 */
export class RecordJournal<T> {
  readonly #journal: Journal;

  constructor(path: string, options: { fsync?: boolean } = {}) {
    this.#journal = new Journal(path, options);
  }

  open(): void {
    this.#journal.open();
  }

  close(): void {
    this.#journal.close();
  }

  append(record: T): void {
    this.#journal.append(record as never);
  }

  read(): { records: T[]; truncated: boolean } {
    const { events, stats } = this.#journal.read();
    return { records: events as unknown as T[], truncated: stats.truncated };
  }

  get path(): string {
    return this.#journal.path;
  }
}

export class Journal {
  readonly #path: string;
  readonly #fsync: boolean;
  #fd: number | undefined;
  #written = 0;

  constructor(path: string, options: { fsync?: boolean } = {}) {
    this.#path = path;
    // Flushing to the platter on every event is the point of a journal. It is
    // switchable because a test suite writing thousands of events does not need
    // to survive a power cut, and nothing else should ever turn it off.
    this.#fsync = options.fsync !== false;
  }

  get path(): string {
    return this.#path;
  }

  /** Open for appending, creating the directory if the volume is empty. */
  open(): void {
    if (this.#fd !== undefined) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#fd = openSync(this.#path, 'a');
  }

  close(): void {
    if (this.#fd === undefined) return;
    try {
      fsyncSync(this.#fd);
    } finally {
      closeSync(this.#fd);
      this.#fd = undefined;
    }
  }

  /**
   * Append one event and flush it.
   *
   * Throws on failure, and the caller must let that propagate: a swallowed
   * journal error is an event that exists in memory, is gone on restart, and
   * was reported as committed.
   */
  append(event: GoldenThreadEvent): void {
    if (this.#fd === undefined) this.open();
    // A single write of a single line. Node writes it in one syscall for any
    // realistic event size, so a concurrent reader sees whole lines.
    const line = `${JSON.stringify(event)}\n`;
    writeSync(this.#fd!, line);
    if (this.#fsync) fsyncSync(this.#fd!);
    this.#written += 1;
  }

  /**
   * Read every event back, oldest first.
   *
   * A torn final line is dropped and reported. An unparseable line anywhere
   * else throws: skipping an event in a hash chain leaves a record that
   * verifies against nothing, and continuing quietly would hide that.
   */
  read(): { events: GoldenThreadEvent[]; stats: JournalStats } {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], stats: { path: this.#path, events: 0, bytes: 0, truncated: false } };
      }
      throw error;
    }

    const lines = raw.split('\n');
    // A well-formed file ends with a newline, so the final element is empty.
    const trailing = lines.pop();
    let truncated = false;

    if (trailing !== undefined && trailing !== '') {
      // Written but not terminated: the process died mid-append.
      truncated = true;
    }

    const events: GoldenThreadEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (line === '') continue;
      try {
        events.push(JSON.parse(line) as GoldenThreadEvent);
      } catch {
        throw new Error(
          `Journal ${this.#path} is corrupt at line ${index + 1}: the line is not valid JSON. ` +
            'This is not a torn write — a truncated tail can only be the final line. ' +
            'Restore from a backup rather than editing the file; the hash chain will not verify without it.',
        );
      }
    }

    return {
      events,
      stats: { path: this.#path, events: events.length, bytes: Buffer.byteLength(raw), truncated },
    };
  }

  /**
   * Rewrite the file without its torn tail.
   *
   * Only called when `read()` reported one. Writes a new file and renames over
   * the old, so a crash during the repair leaves the original intact rather
   * than a half-repaired journal.
   */
  repair(events: GoldenThreadEvent[]): void {
    const temporary = `${this.#path}.repair`;
    writeFileSync(temporary, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    renameSync(temporary, this.#path);
    this.close();
    this.open();
  }

  stats(): JournalStats {
    let bytes = 0;
    try {
      bytes = statSync(this.#path).size;
    } catch {
      bytes = 0;
    }
    return { path: this.#path, events: this.#written, bytes, truncated: false };
  }
}
