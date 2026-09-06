import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import type { GoldenThreadLedger, LedgerSnapshotState } from './ledger.ts';

/**
 * A snapshot of the ledger beside the journal, so boot replays only the tail.
 *
 * Boot read the whole journal and replayed every event: two hashes and a
 * patch per event, from the first event the platform ever wrote. The file is
 * still read in full — every event has to be in memory, because the audit
 * feed, the exports and the chain verifier walk them — but the state no
 * longer has to be rebuilt from the first event. `<journal>.snapshot` holds
 * the materialised state as at event N: every entity record, every chain
 * head, the recorded-hash exceptions and the discrepancies found so far.
 * Boot loads it, checks it against the journal, and replays events N+1
 * onward.
 *
 * **Checked against the journal, not trusted.** The snapshot must name
 * exactly as many events as the journal's prefix, the last of them by id,
 * and the chain head of every project as the prefix's events leave it; the
 * file carries a SHA-256 over its own bytes and a torn or edited one is
 * refused. Anything wrong falls back to a full replay with a line on stderr
 * — a snapshot is a shortcut, never a source of truth. What the shortcut
 * skips is re-verifying the prefix's chain event by event; the assurance
 * sweep re-proves every chain continuously, so a prefix that was altered
 * after the snapshot is still found, by the sweep rather than the boot.
 *
 * **Taken without stopping.** The state is captured in one synchronous step
 * — the count, the heads, the records — and the records are frozen objects
 * the ledger replaces rather than mutates, so writing them out in batches
 * with the event loop yielded between batches serialises the state as at
 * the capture whatever has been committed since. Written beside the target
 * and renamed over it, so a crash mid-write leaves the previous snapshot.
 *
 * **On a timer, when it is worth it.** Every `LEDGER_SNAPSHOT_INTERVAL_MINUTES`
 * (default 60) if at least `LEDGER_SNAPSHOT_MIN_EVENTS` (default 1,000) have
 * been written since the last one. Zero turns the timer off; *Take a
 * snapshot now* on the Event Store screen still works. The backup ships the
 * snapshot with the journal, and a restore without one is a full replay.
 */

export type SnapshotStats = {
  path: string;
  takenAt: string;
  /** The event count the snapshot stands at. */
  events: number;
  entities: number;
  bytes: number;
};

type Header = {
  version: 1;
  takenAt: string;
  events: number;
  lastEventId: string;
  chainHeads: LedgerSnapshotState['chainHeads'];
  recordedHashes: LedgerSnapshotState['recordedHashes'];
  discrepancies: LedgerSnapshotState['discrepancies'];
  entities: number;
};

export function snapshotPath(journalPath = config.ledger.journalPath): string {
  return `${journalPath}.snapshot`;
}

const BATCH = 500;

/**
 * Write the ledger's state to the path. Yields to the event loop between
 * batches of records; the state written is the state as at the capture.
 */
export async function writeSnapshot(ledger: GoldenThreadLedger, path: string, now = new Date()): Promise<SnapshotStats> {
  const state = ledger.snapshotState();
  const header: Header = {
    version: 1,
    takenAt: now.toISOString(),
    events: state.events,
    lastEventId: state.lastEventId,
    chainHeads: state.chainHeads,
    recordedHashes: state.recordedHashes,
    discrepancies: state.discrepancies,
    entities: state.entities.length,
  };
  const hash = createHash('sha256');
  const chunks: string[] = [];
  const push = (line: string): void => {
    chunks.push(line);
    hash.update(line);
  };
  push(`${JSON.stringify(header)}\n`);
  for (let index = 0; index < state.entities.length; index += BATCH) {
    for (const record of state.entities.slice(index, index + BATCH)) push(`${JSON.stringify(record)}\n`);
    if (index + BATCH < state.entities.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  chunks.push(`${JSON.stringify({ end: true, sha256: hash.digest('hex') })}\n`);
  const bytes = Buffer.from(chunks.join(''), 'utf8');
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes);
  renameSync(temporary, path);
  return { path, takenAt: header.takenAt, events: header.events, entities: header.entities, bytes: bytes.length };
}

/**
 * Read a snapshot back, or refuse it. `undefined` where none exists; a throw
 * for one that is torn, edited or of a version this build does not read —
 * the caller says so and replays in full.
 */
export function readSnapshot(path: string): { state: LedgerSnapshotState; stats: SnapshotStats } | undefined {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const text = raw.toString('utf8');
  const lastBreak = text.lastIndexOf('\n', text.length - 2);
  if (!text.endsWith('\n') || lastBreak < 0) throw new DomainError('SNAPSHOT_CORRUPT', `${path} is torn: it does not end with its own hash line.`);
  const body = text.slice(0, lastBreak + 1);
  const trailer = text.slice(lastBreak + 1);
  let end: { end?: boolean; sha256?: string };
  try {
    end = JSON.parse(trailer) as { end?: boolean; sha256?: string };
  } catch {
    throw new DomainError('SNAPSHOT_CORRUPT', `${path} is torn: its last line is not the hash line.`);
  }
  if (end.end !== true || createHash('sha256').update(body).digest('hex') !== end.sha256) {
    throw new DomainError('SNAPSHOT_CORRUPT', `${path} does not hash to the value it carries; it has been altered or torn.`);
  }
  const lines = body.split('\n');
  lines.pop();
  let header: Header;
  try {
    header = JSON.parse(lines[0] ?? '') as Header;
  } catch {
    throw new DomainError('SNAPSHOT_CORRUPT', `${path} has no readable header.`);
  }
  if (header.version !== 1) throw new DomainError('SNAPSHOT_CORRUPT', `${path} is snapshot version ${String(header.version)}, which this build does not read.`);
  if (lines.length - 1 !== header.entities) {
    throw new DomainError('SNAPSHOT_CORRUPT', `${path} names ${header.entities} entities and carries ${lines.length - 1}.`);
  }
  const entities = lines.slice(1).map((line) => JSON.parse(line) as LedgerSnapshotState['entities'][number]);
  return {
    state: {
      events: header.events,
      lastEventId: header.lastEventId,
      chainHeads: header.chainHeads,
      recordedHashes: header.recordedHashes,
      discrepancies: header.discrepancies,
      entities,
    },
    stats: { path, takenAt: header.takenAt, events: header.events, entities: header.entities, bytes: raw.length },
  };
}

// --- the timer, and what the operator sees ---------------------------------

export type SnapshotPosition = {
  configured: boolean;
  path: string | null;
  intervalMinutes: number;
  minEvents: number;
  enabled: boolean;
  /** The snapshot on the volume now, if any. */
  current: SnapshotStats | null;
  /** How this process came up. */
  boot: { from: 'SNAPSHOT' | 'JOURNAL' | 'NOTHING'; fromSnapshot: number; replayed: number; refused?: string } | null;
  lastTakenAt: string | null;
  lastError: string | null;
  running: boolean;
  /** Events written since the snapshot on the volume; what the next boot would replay. */
  eventsSince: number;
};

let boot: SnapshotPosition['boot'] = null;
let lastTakenAt: string | null = null;
let lastError: string | null = null;
let running = false;
let timer: NodeJS.Timeout | undefined;
let lastEvents = 0;

/** Boot says how it came up, once. */
export function recordBoot(outcome: NonNullable<SnapshotPosition['boot']>): void {
  boot = outcome;
  lastEvents = outcome.fromSnapshot;
}

/** Test isolation only. */
export function resetSnapshots(): void {
  boot = null;
  lastTakenAt = null;
  lastError = null;
  running = false;
  lastEvents = 0;
}

/** Take one now, whatever the timer thinks. */
export async function takeSnapshot(ledger: GoldenThreadLedger, path = snapshotPath()): Promise<{ taken: boolean; stats?: SnapshotStats; because?: string }> {
  if (config.ledger.journalPath === '' && path === snapshotPath()) return { taken: false, because: 'No journal is configured, so there is nothing a snapshot would shorten.' };
  if (running) return { taken: false, because: 'A snapshot is already being written.' };
  running = true;
  try {
    const stats = await writeSnapshot(ledger, path);
    lastTakenAt = stats.takenAt;
    lastEvents = stats.events;
    lastError = null;
    return { taken: true, stats };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return { taken: false, because: lastError };
  } finally {
    running = false;
  }
}

export function snapshotPosition(ledger: GoldenThreadLedger): SnapshotPosition {
  const configured = config.ledger.journalPath !== '';
  let current: SnapshotStats | null = null;
  if (configured) {
    try {
      const stat = statSync(snapshotPath());
      const first = readFileSync(snapshotPath(), { encoding: 'utf8', flag: 'r' }).split('\n')[0] ?? '';
      const header = JSON.parse(first) as Header;
      current = { path: snapshotPath(), takenAt: header.takenAt, events: header.events, entities: header.entities, bytes: stat.size };
    } catch {
      current = null;
    }
  }
  return {
    configured,
    path: configured ? snapshotPath() : null,
    intervalMinutes: config.ledger.snapshotIntervalMinutes,
    minEvents: config.ledger.snapshotMinEvents,
    enabled: timer !== undefined,
    current,
    boot,
    lastTakenAt,
    lastError,
    running,
    eventsSince: Math.max(0, ledger.size - (current?.events ?? lastEvents)),
  };
}

/** Arm the timer: a snapshot each interval, when enough has been written since the last. */
export function startSnapshots(ledger: GoldenThreadLedger): () => void {
  if (config.ledger.journalPath === '' || config.ledger.snapshotIntervalMinutes <= 0 || timer) return () => stopSnapshots();
  timer = setInterval(() => {
    if (ledger.size - lastEvents < config.ledger.snapshotMinEvents) return;
    void takeSnapshot(ledger);
  }, config.ledger.snapshotIntervalMinutes * 60_000);
  timer.unref();
  return () => stopSnapshots();
}

export function stopSnapshots(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
