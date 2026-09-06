import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { readiness } from '../src/api/readiness.ts';
import { config } from '../src/config.ts';
import {
  backupPosition,
  backupSources,
  backupStanding,
  resetBackups,
  runBackup,
  useBackupStore,
  type BackupManifest,
} from '../src/ops/backup.ts';
import { WATCH_RULES } from '../src/ops/watch.ts';
import { Platform } from '../src/platform.ts';
import { S3Client } from '../src/store/s3.ts';

/**
 * The record shipped off the host.
 *
 * A copy on the same disk survives a bad deploy and nothing else. What is
 * asserted: every journal file and the site media go up as one stamped set,
 * in parts a restore can `cat` back in order, with a manifest naming each
 * file and its hash written last; the newest sets are kept and older ones
 * pruned only after a run lands; a run that fails leaves what it found and
 * says why; and the standing watch rule judges the age of the last set.
 */

let store: Server | undefined;
let endpoint = '';
let objects = new Map<string, Buffer>();
let refuse = false;
let platform: Platform;
const scratch = mkdtempSync(join(tmpdir(), 'construx-backup-'));

const originalBackup = { ...config.backup };
const ledger = config.ledger as unknown as { journalPath: string };
const site = config.site as unknown as { mediaPath: string };
const originalJournal = ledger.journalPath;
const originalMedia = site.mediaPath;

function tune(over: Partial<typeof config.backup>): void {
  Object.assign(config.backup as object, originalBackup, over);
}

function client(): S3Client {
  return new S3Client({ endpoint, region: 'eu-west-2', bucket: 'construx', accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'not-a-real-credential', pathStyle: true, timeoutMs: 2_000 });
}

before(async () => {
  await new Promise<void>((resolve) => {
    store = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (refuse) {
          response.writeHead(503).end('<Error><Code>SlowDown</Code></Error>');
          return;
        }
        const url = new URL(request.url ?? '/', 'http://placeholder');
        const key = decodeURIComponent(url.pathname.replace(/^\/construx\/?/, ''));
        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const body =
            '<ListBucketResult><IsTruncated>false</IsTruncated>' +
            [...objects.entries()]
              .filter(([name]) => name.startsWith(prefix))
              .map(([name, value]) => `<Contents><Key>${name}</Key><Size>${value.length}</Size></Contents>`)
              .join('') +
            '</ListBucketResult>';
          response.writeHead(200, { 'content-type': 'application/xml' }).end(body);
          return;
        }
        if (request.method === 'PUT') {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        if (request.method === 'DELETE') {
          objects.delete(key);
          response.writeHead(204).end();
          return;
        }
        const held = objects.get(key);
        if (!held) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200).end(held);
      });
    });
    store.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(store!.address() as { port: number }).port}`;
      resolve();
    });
  });

  // A journal of two and a half parts, its side files, and two pictures.
  const journal = join(scratch, 'ledger.jsonl');
  const line = `${JSON.stringify({ eventId: 'x'.repeat(26), eventType: 'FILLER', payload: 'y'.repeat(200) })}\n`;
  writeFileSync(journal, line.repeat(Math.ceil((2.5 * 1_048_576) / line.length)));
  writeFileSync(`${journal}.acu`, '{"tenantId":"t","kind":"GRANT"}\n');
  writeFileSync(`${journal}.revoked`, '');
  mkdirSync(join(scratch, 'media'));
  writeFileSync(join(scratch, 'media', 'hero.jpg'), Buffer.alloc(1_000, 0xff));
  writeFileSync(join(scratch, 'media', 'plate.webp'), Buffer.alloc(500, 0x01));
  ledger.journalPath = journal;
  site.mediaPath = join(scratch, 'media');
  platform = new Platform();
});

after(() => {
  store?.close();
  useBackupStore(undefined);
  tune({});
  ledger.journalPath = originalJournal;
  site.mediaPath = originalMedia;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  objects = new Map();
  refuse = false;
  resetBackups();
  useBackupStore(client());
  tune({ intervalMinutes: 60, keep: 2, partMb: 1, prefix: 'backups' });
});

describe('what a set is made of', () => {
  it('names every journal file that exists and every picture, and nothing that does not', () => {
    const names = backupSources().map((source) => source.name).sort();
    assert.deepEqual(names, ['ledger.jsonl', 'ledger.jsonl.acu', 'ledger.jsonl.revoked', 'site-media/hero.jpg', 'site-media/plate.webp']);
  });
});

describe('a run', () => {
  it('ships the set in parts with a manifest last, and the parts reassemble to the file', async () => {
    const run = await runBackup(platform, new Date('2026-09-06T06:00:00Z'));
    assert.equal(run.ok, true, run.error ?? '');
    assert.equal(run.stamp, '20260906T060000Z');
    assert.equal(run.files.length, 5);

    const chain = run.files.find((file) => file.name === 'ledger.jsonl')!;
    assert.equal(chain.parts, 3, 'two and a half megabytes in one-megabyte parts');
    const parts = [0, 1, 2].map((index) => objects.get(`backups/20260906T060000Z/ledger.jsonl.part-000${index}`)!);
    assert.ok(parts.every(Boolean), 'every part is in the store');
    const whole = Buffer.concat(parts);
    assert.equal(whole.length, chain.bytes);
    assert.equal(createHash('sha256').update(whole).digest('hex'), chain.sha256, 'the manifest hash is over the whole file');

    const empty = run.files.find((file) => file.name === 'ledger.jsonl.revoked')!;
    assert.equal(empty.parts, 1, 'an empty file still has a part, so a restore finds it');
    assert.equal(objects.get('backups/20260906T060000Z/ledger.jsonl.revoked.part-0000')!.length, 0);

    const manifest = JSON.parse(objects.get('backups/20260906T060000Z/manifest.json')!.toString('utf8')) as BackupManifest;
    assert.equal(manifest.version, 1);
    assert.equal(manifest.partBytes, 1_048_576);
    assert.equal(manifest.events, platform.ledger.size);
    assert.deepEqual(manifest.files.map((file) => file.name).sort(), run.files.map((file) => file.name).sort());

    const position = backupPosition();
    assert.equal(position.configured, true);
    assert.equal(position.lastSuccessAt, '2026-09-06T06:00:00.000Z');
    assert.equal(position.sets.length, 1);
    assert.equal(position.sets[0]!.manifest, true);
    assert.equal(position.lastRun?.ok, true);
  });

  it('keeps the newest sets and prunes the rest only after the new one lands', async () => {
    await runBackup(platform, new Date('2026-09-06T06:00:00Z'));
    await runBackup(platform, new Date('2026-09-06T12:00:00Z'));
    const third = await runBackup(platform, new Date('2026-09-06T18:00:00Z'));
    assert.equal(third.ok, true);
    assert.deepEqual(third.pruned, ['20260906T060000Z']);
    const stamps = [...new Set([...objects.keys()].map((key) => key.split('/')[1]))].sort();
    assert.deepEqual(stamps, ['20260906T120000Z', '20260906T180000Z']);
    assert.equal(backupPosition().sets.length, 2);
    assert.equal(backupPosition().sets[0]!.stamp, '20260906T180000Z', 'newest first');
  });

  it('says why it failed, leaves what it found, and the position shows it', async () => {
    await runBackup(platform, new Date('2026-09-06T06:00:00Z'));
    refuse = true;
    const failed = await runBackup(platform, new Date('2026-09-06T12:00:00Z'));
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /refused the upload|503/);
    assert.equal(backupPosition().lastSuccessAt, '2026-09-06T06:00:00.000Z', 'the last success stands');
    assert.equal(backupPosition().lastRun?.ok, false);
    refuse = false;
    // Nothing of the failed set counts as a set, and nothing earlier was pruned.
    const stamps = [...new Set([...objects.keys()].map((key) => key.split('/')[1]))];
    assert.deepEqual(stamps, ['20260906T060000Z']);
  });

  it('refuses with nowhere to ship to', async () => {
    useBackupStore(new S3Client({ ...config.objectStore, endpoint: '', bucket: '' }));
    const run = await runBackup(platform);
    assert.equal(run.ok, false);
    assert.match(run.error ?? '', /No object store is configured/);
    assert.equal(backupPosition().configured, false);
  });
});

describe('the standing rule', () => {
  it('declines to judge outside production with no store, and judges age once there is one', async () => {
    useBackupStore(new S3Client({ ...config.objectStore, endpoint: '', bucket: '' }));
    assert.equal(backupStanding().judged, false);
    useBackupStore(client());

    const fresh = backupStanding(new Date('2026-09-06T06:30:00Z'));
    assert.equal(fresh.judged, true);
    assert.equal(fresh.breached, false, 'the first set is due within the interval');

    await runBackup(platform, new Date('2026-09-06T06:00:00Z'));
    const young = backupStanding(new Date('2026-09-06T07:59:00Z'));
    assert.equal(young.breached, false);
    assert.match(young.detail, /shipped 119 minutes ago/);

    const stale = backupStanding(new Date('2026-09-06T08:01:00Z'));
    assert.equal(stale.breached, true, 'older than two intervals');
    assert.match(stale.detail, /121 minutes ago/);

    tune({ intervalMinutes: 0 });
    assert.equal(backupStanding().judged, false, 'switched off, outside production');
  });

  it('is in the watch with a sentence for what and why', () => {
    const rule = WATCH_RULES.find((entry) => entry.id === 'backup_offhost')!;
    assert.ok(rule);
    assert.equal(rule.severity, 'CRITICAL');
    assert.equal(rule.standing, true);
  });

  it('is a critical readiness capability', () => {
    const capability = readiness().capabilities.find((entry) => entry.key === 'backup.offhost')!;
    assert.equal(capability.critical, true);
    assert.equal(capability.state, config.objectStore.endpoint === '' ? 'NOT_SET' : 'CONFIGURED');
  });
});
