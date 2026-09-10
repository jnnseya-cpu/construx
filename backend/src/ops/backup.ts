import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config, isProduction } from '../config.ts';
import type { Platform } from '../platform.ts';
import { S3Client } from '../store/s3.ts';

/**
 * The record shipped off the host, on a timer.
 *
 * `deploy/autodeploy.sh` copies the journal files before every deploy — onto
 * the same disk the journal lives on. That survives a bad deploy and nothing
 * else: a lost volume, a lost host, a ransomware run over the mount, all take
 * the copies with the original. The runbook said so and said nothing in the
 * repository shipped a set off the box. This does.
 *
 * **What is shipped.** Every journal file — the chain, the ACU wallets, the
 * page views, the revoked sessions, and the ledger snapshot where one exists
 * — and the site's own pictures, as one set under `backups/<stamp>/` in the
 * configured object store. Evidence is not in the set, deliberately: where an
 * object store is configured the evidence store *is* that object store (it is
 * the only store, never a cache in front of the volume), so the evidence is
 * already off the host by construction, and where none is configured there is
 * nowhere to ship a backup either.
 *
 * **Consistent without stopping.** The journal files are append-only, so a
 * copy taken while the service runs is a valid prefix of the record: it may
 * miss events written during the copy and cannot contain a half-written
 * earlier one. A torn last line in a backup loads exactly as a torn line
 * from a crash. The manifest is written last, and only after every file is
 * up, so a set with a manifest is a whole set.
 *
 * **In parts, not whole.** A file goes up in parts of `BACKUP_PART_MB`, read
 * through a file handle rather than into memory, because the journal is the
 * one file on the platform that only grows and a two-gigabyte `readFile` on
 * the process that serves everybody is the outage the backup exists to
 * survive. Restore is `cat` in part order; the manifest names every part and
 * the whole file's SHA-256, so a restored file can be checked before boot.
 *
 * **Retention.** The newest `BACKUP_KEEP` sets stay; older ones are deleted
 * after a successful run, never before it, so a run that fails cannot leave
 * fewer sets than it found.
 *
 * **Told when it stops.** `ops/watch.ts` carries `backup_offhost`: standing,
 * fires when no successful set is younger than two intervals, or — on a
 * production deployment — when there is no object store to ship to at all.
 */

export type BackupFile = {
  name: string;
  bytes: number;
  parts: number;
  sha256: string;
};

export type BackupManifest = {
  version: 1;
  stamp: string;
  takenAt: string;
  completedAt: string;
  commit: string;
  events: number;
  partBytes: number;
  files: BackupFile[];
};

export type BackupRun = {
  at: string;
  ok: boolean;
  stamp: string;
  durationMs: number;
  files: BackupFile[];
  bytes: number;
  pruned: string[];
  error?: string;
};

export type BackupPosition = {
  /** An object store is configured to ship to. */
  configured: boolean;
  /** The timer is armed: configured, interval above zero, and this is the primary. */
  enabled: boolean;
  intervalMinutes: number;
  keep: number;
  destination: string;
  startedAt: string;
  lastRun: BackupRun | null;
  lastSuccessAt: string | null;
  nextAt: string | null;
  /** Sets the store held at the last listing, newest first. */
  sets: Array<{ stamp: string; bytes: number; files: number; manifest: boolean }>;
  running: boolean;
};

let client: S3Client | undefined;
function store(): S3Client {
  client ??= new S3Client(config.objectStore);
  return client;
}

/** Tests only: point the module at a store of their own. */
export function useBackupStore(next: S3Client | undefined): void {
  client = next;
}

const startedAt = new Date().toISOString();
let lastRun: BackupRun | null = null;
let lastSuccessAt: string | null = null;
let lastSets: BackupPosition['sets'] = [];
let running = false;
let timer: NodeJS.Timeout | undefined;
let nextAt: string | null = null;

/** Test isolation only. */
export function resetBackups(): void {
  lastRun = null;
  lastSuccessAt = null;
  lastSets = [];
  running = false;
  nextAt = null;
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** The files a set is made of, as they stand now. Only the ones that exist. */
export function backupSources(): Array<{ name: string; path: string }> {
  const journal = config.ledger.journalPath;
  const sources: Array<{ name: string; path: string }> = [];
  if (journal !== '') {
    for (const suffix of ['', '.acu', '.views', '.revoked', '.snapshot']) {
      const path = `${journal}${suffix}`;
      if (existsSync(path) && statSync(path).isFile()) sources.push({ name: `${basename(journal)}${suffix}`, path });
    }
  }
  const media = process.env.SITE_MEDIA_PATH ?? config.site.mediaPath;
  if (media !== '' && existsSync(media) && statSync(media).isDirectory()) {
    for (const entry of readdirSync(media, { withFileTypes: true })) {
      if (entry.isFile()) sources.push({ name: `site-media/${entry.name}`, path: join(media, entry.name) });
    }
  }
  return sources;
}

/** Upload one file in parts through a handle, hashing as it goes. */
async function ship(target: S3Client, prefix: string, source: { name: string; path: string }, partBytes: number): Promise<BackupFile> {
  const handle = await open(source.path, 'r');
  const hash = createHash('sha256');
  let parts = 0;
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(partBytes);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, partBytes, bytes);
      if (bytesRead === 0) break;
      const part = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(part);
      await target.put(`${prefix}/${source.name}.part-${String(parts).padStart(4, '0')}`, part, 'application/octet-stream');
      parts += 1;
      bytes += bytesRead;
      if (bytesRead < partBytes) break;
    }
  } finally {
    await handle.close();
  }
  if (parts === 0) {
    // An empty file is still a file in the set; a restore that finds no part
    // for a name in the manifest would otherwise read as a missing file.
    await target.put(`${prefix}/${source.name}.part-0000`, Buffer.alloc(0), 'application/octet-stream');
    parts = 1;
  }
  return { name: source.name, bytes, parts, sha256: hash.digest('hex') };
}

/** Group what the store holds under the prefix into sets, newest first. */
async function listSets(target: S3Client): Promise<BackupPosition['sets']> {
  const objects = await target.list(`${config.backup.prefix}/`);
  const sets = new Map<string, { bytes: number; files: number; manifest: boolean }>();
  for (const object of objects) {
    const rest = object.key.slice(config.backup.prefix.length + 1);
    const stamp = rest.split('/')[0] ?? '';
    if (!/^\d{8}T\d{6}Z$/.test(stamp)) continue;
    const set = sets.get(stamp) ?? { bytes: 0, files: 0, manifest: false };
    set.bytes += object.size;
    set.files += 1;
    if (rest === `${stamp}/manifest.json`) set.manifest = true;
    sets.set(stamp, set);
  }
  return [...sets.entries()].map(([stamp, set]) => ({ stamp, ...set })).sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

/**
 * One backup. Every file up, then the manifest, then the prune. Throws
 * nothing: the outcome is on the position, and the watch reads it.
 */
export async function runBackup(platform: Platform, now = new Date()): Promise<BackupRun> {
  const target = store();
  const stamp = stampOf(now);
  const began = Date.now();
  if (running) {
    return { at: now.toISOString(), ok: false, stamp, durationMs: 0, files: [], bytes: 0, pruned: [], error: 'A backup is already running' };
  }
  running = true;
  try {
    if (!target.configured) throw new Error('No object store is configured; there is nowhere to ship the record to');
    const sources = backupSources();
    if (sources.length === 0) throw new Error('Nothing to back up: no journal file exists yet');

    const prefix = `${config.backup.prefix}/${stamp}`;
    const partBytes = Math.max(1, config.backup.partMb) * 1_048_576;
    const files: BackupFile[] = [];
    for (const source of sources) files.push(await ship(target, prefix, source, partBytes));

    const manifest: BackupManifest = {
      version: 1,
      stamp,
      takenAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      commit: config.buildCommit || 'unknown',
      events: platform.ledger.size,
      partBytes,
      files,
    };
    await target.put(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');

    // Prune after, never before: a run that fails leaves every set it found.
    const sets = await listSets(target);
    const pruned: string[] = [];
    for (const old of sets.slice(Math.max(1, config.backup.keep))) {
      const objects = await target.list(`${config.backup.prefix}/${old.stamp}/`);
      for (const object of objects) await target.delete(object.key);
      pruned.push(old.stamp);
    }
    lastSets = sets.filter((set) => !pruned.includes(set.stamp));

    const run: BackupRun = {
      at: now.toISOString(),
      ok: true,
      stamp,
      durationMs: Date.now() - began,
      files,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      pruned,
    };
    lastRun = run;
    lastSuccessAt = run.at;
    return run;
  } catch (error) {
    const run: BackupRun = {
      at: now.toISOString(),
      ok: false,
      stamp,
      durationMs: Date.now() - began,
      files: [],
      bytes: 0,
      pruned: [],
      error: error instanceof Error ? error.message : String(error),
    };
    lastRun = run;
    return run;
  } finally {
    running = false;
  }
}

export function backupsEnabled(): boolean {
  return store().configured && config.backup.intervalMinutes > 0 && config.ledger.journalPath !== '';
}

export function backupPosition(): BackupPosition {
  return {
    configured: store().configured,
    enabled: timer !== undefined,
    intervalMinutes: config.backup.intervalMinutes,
    keep: config.backup.keep,
    destination: store().configured ? `${store().address}/${config.backup.prefix}/` : 'not configured',
    startedAt,
    lastRun,
    lastSuccessAt,
    nextAt,
    sets: lastSets,
    running,
  };
}

/** What the standing watch rule judges: whether a set young enough exists, or could. */
export function backupStanding(now = new Date()): { judged: boolean; breached: boolean; detail: string } {
  if (!store().configured) {
    // An operator who has read this and written down that they are running
    // without an off-host copy is not told it again every interval. The rule
    // declines to judge rather than passing: nothing is being backed up, and a
    // green light for that would be the platform saying something untrue.
    const accepted = config.backup.offhostAccepted.trim();
    if (accepted !== '') {
      return {
        judged: false,
        breached: false,
        detail: `no object store is configured, and running without one is recorded as accepted: "${accepted}"`,
      };
    }
    return isProduction()
      ? { judged: true, breached: true, detail: 'No object store is configured, so the record is on this host only; a lost volume is a lost record' }
      : { judged: false, breached: false, detail: 'no object store is configured on this deployment' };
  }
  if (config.backup.intervalMinutes <= 0) {
    return isProduction()
      ? { judged: true, breached: true, detail: 'BACKUP_INTERVAL_MINUTES is 0, so nothing ships the record off the host' }
      : { judged: false, breached: false, detail: 'the off-host backup is switched off' };
  }
  const allowance = config.backup.intervalMinutes * 2 * 60_000;
  const reference = lastSuccessAt ?? startedAt;
  const age = now.getTime() - Date.parse(reference);
  if (age > allowance) {
    return {
      judged: true,
      breached: true,
      detail: lastSuccessAt
        ? `the last successful set was ${Math.round(age / 60_000)} minutes ago${lastRun?.error ? `; the last run failed: ${lastRun.error}` : ''}`
        : `no set has been shipped since this process started ${Math.round(age / 60_000)} minutes ago${lastRun?.error ? `; the last run failed: ${lastRun.error}` : ''}`,
    };
  }
  return {
    judged: true,
    breached: false,
    detail: lastSuccessAt ? `the last set shipped ${Math.round(age / 60_000)} minutes ago to ${store().address}` : 'no set yet on this process; the first is due within the interval',
  };
}

/** Arm the timer. The first run is one interval out: boot is busy enough. */
export function startBackupSchedule(platform: Platform, onRun?: (run: BackupRun) => void): () => void {
  if (!backupsEnabled() || timer) return () => stopBackupSchedule();
  const intervalMs = config.backup.intervalMinutes * 60_000;
  nextAt = new Date(Date.now() + intervalMs).toISOString();
  timer = setInterval(() => {
    nextAt = new Date(Date.now() + intervalMs).toISOString();
    void runBackup(platform).then((run) => onRun?.(run));
  }, intervalMs);
  timer.unref();
  return () => stopBackupSchedule();
}

export function stopBackupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  nextAt = null;
}
