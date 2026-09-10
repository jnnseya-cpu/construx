import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The preflight that answers the only question an operator has on the day they
 * create a bucket: are these five values right?
 *
 * Everything the off-host backup needs was built and tested — the SigV4 signer
 * against AWS's own vector, the shipper, the manifest, the restore drill, the
 * readiness line, the watch rule. None of it could answer that question. The
 * answer came from restarting the service and reading a screen, which collapses
 * three different faults into one red line: a typo in the endpoint, a key with
 * no write permission, and a bucket the endpoint does not serve all look
 * identical from outside. And a wrong secret could sit unnoticed for a backup
 * interval, so the first news of it arrives from the alarm that exists for a
 * lost volume.
 *
 * Driven here as the operator drives it: the real command, in its own process,
 * against a store speaking real S3 — including the two ways a credential fails
 * that are worse than being refused outright, because both look like success.
 * A store that lists but will not write ships nothing. A store that writes but
 * will not delete fills up until somebody gets a bill.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'objectstore.ts');

let store: Server | undefined;
let endpoint = '';
const objects = new Map<string, Buffer>();

/** Which verbs this store will honour. Everything else answers 403. */
let allow = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'LIST']);
/** Return something other than what was stored, for the byte-for-byte check. */
let corrupt = false;

/**
 * The command, in its own process, awaited rather than blocked on.
 *
 * `spawnSync` cannot be used here: the fake store runs in this process, and a
 * synchronous child blocks the event loop that would have answered it — every
 * request times out and every check fails for a reason that has nothing to do
 * with the code under test.
 */
async function run(over: Record<string, string> = {}): Promise<{ status: number; out: string }> {
  const child = spawn(process.execPath, [CLI], {
    env: {
      ...process.env,
      OBJECT_STORE_ENDPOINT: endpoint,
      OBJECT_STORE_REGION: 'eu-west-2',
      OBJECT_STORE_BUCKET: 'construx',
      OBJECT_STORE_ACCESS_KEY_ID: 'AKIDTESTONLY',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'not-a-real-credential',
      OBJECT_STORE_PATH_STYLE: 'true',
      OBJECT_STORE_TIMEOUT_MS: '4000',
      BACKUP_PREFIX: 'backups',
      ...over,
    },
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.on('data', (chunk: string) => { out += chunk; });

  const status = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });
  return { status, out };
}

before(async () => {
  await new Promise<void>((resolve) => {
    store = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://placeholder');
        const key = decodeURIComponent(url.pathname.replace(/^\/construx\/?/, ''));

        if (url.searchParams.get('list-type') === '2') {
          if (!allow.has('LIST')) {
            response.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
            return;
          }
          const prefix = url.searchParams.get('prefix') ?? '';
          response
            .writeHead(200, { 'content-type': 'application/xml' })
            .end(
              '<ListBucketResult><IsTruncated>false</IsTruncated>' +
                [...objects.entries()]
                  .filter(([name]) => name.startsWith(prefix))
                  .map(([name, value]) => `<Contents><Key>${name}</Key><Size>${value.length}</Size></Contents>`)
                  .join('') +
                '</ListBucketResult>',
            );
          return;
        }

        if (!allow.has(request.method ?? '')) {
          response.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>not permitted for this key</Message></Error>');
          return;
        }
        if (request.method === 'PUT') {
          objects.set(key, corrupt ? Buffer.from('something else entirely') : Buffer.concat(chunks));
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
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(held);
      });
    });
    store.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(store!.address() as { port: number }).port}`;
      resolve();
    });
  });
});

after(() => {
  store?.close();
});

describe('the object store preflight', () => {
  it('passes a store that can do everything the platform asks of it', async () => {
    allow = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'LIST']);
    corrupt = false;
    objects.clear();

    const { status, out } = await run();
    assert.equal(status, 0, out);
    assert.match(out, /The bucket answers/);
    assert.match(out, /Write/);
    assert.match(out, /byte for byte/);
    assert.match(out, /Appears in a listing/);
    assert.match(out, /Delete/);
    assert.match(out, /This store will hold the record/);
  });

  it('leaves the bucket exactly as it found it', () => {
    // It writes one object and removes it. A preflight that leaves litter in a
    // customer's bucket is a preflight somebody stops running.
    assert.deepEqual([...objects.keys()], [], 'the preflight left an object behind');
  });

  it('prints no secret, not even part of one', async () => {
    const { out } = await run();
    assert.ok(!out.includes('not-a-real-credential'), 'the secret key reached the terminal');
    assert.ok(!out.includes('AKIDTESTONLY'), 'the access key id reached the terminal');
    // The endpoint and the bucket are shown on purpose: an operator has to see
    // which store answered, and neither is a credential.
    assert.match(out, /construx/);
  });

  it('fails a credential that can list but not write', async () => {
    // The failure that matters most and looks least like one. Readiness says
    // "configured", the screen goes green, and nothing is ever shipped.
    allow = new Set(['GET', 'HEAD', 'DELETE', 'LIST']);
    objects.clear();

    const { status, out } = await run();
    assert.equal(status, 1);
    assert.match(out, /FAIL.*Write/s);
    assert.match(out, /the credential can list but not write/);
    assert.match(out, /Nothing has been changed/);
  });

  it('fails a credential that can write but not delete', async () => {
    // The rotation removes sets beyond BACKUP_KEEP. Without delete the bucket
    // grows for ever, silently, and the first symptom is an invoice.
    allow = new Set(['GET', 'HEAD', 'PUT', 'LIST']);
    objects.clear();

    const { status, out } = await run();
    assert.equal(status, 1);
    assert.match(out, /FAIL.*Delete/s);
    assert.match(out, /fills the bucket/);
    // The object it could not remove is named, because somebody has to.
    assert.match(out, /backups\/\.preflight\//);
  });

  it('fails a store that returns something other than what was sent', async () => {
    allow = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'LIST']);
    corrupt = true;
    objects.clear();

    const { status, out } = await run();
    corrupt = false;
    assert.equal(status, 1);
    assert.match(out, /FAIL.*byte for byte/s);
    assert.match(out, /What came back is not what went up/);
  });

  it('names the keys that are absent rather than reporting a connection failure', async () => {
    // Nothing configured is not a fault to debug; it is a deployment that has
    // not been given a bucket yet, and the message says which values are needed.
    const { status, out } = await run({ OBJECT_STORE_BUCKET: '', OBJECT_STORE_SECRET_ACCESS_KEY: '' });
    assert.equal(status, 1);
    assert.match(out, /No object store is configured/);
    assert.match(out, /OBJECT_STORE_BUCKET/);
    assert.match(out, /OBJECT_STORE_SECRET_ACCESS_KEY/);
    assert.ok(!out.includes('OBJECT_STORE_ENDPOINT,'), 'a key that is set was listed as missing');
  });

  it('warns about the two R2 settings nobody guesses, without failing on them', async () => {
    // R2 signs against "auto" and serves path style. Each one wrong reads as
    // "the security token is invalid" — an error about credentials, for a bug
    // about a region string. Advice, never a refusal: a deployment that works
    // while disagreeing with this list is still working.
    const { out } = await run({ OBJECT_STORE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com', OBJECT_STORE_REGION: 'us-east-1' });
    assert.match(out, /R2 signs against "auto"/);
    assert.match(out, /Worth checking/);
  });

  it('warns that a zero interval ships nothing, even once the store works', async () => {
    const { status, out } = await run({ BACKUP_INTERVAL_MINUTES: '0' });
    assert.equal(status, 0, out);
    assert.match(out, /nothing is shipped on a timer/);
  });
});

/**
 * The wrapper, against a `.env` shaped like a real one.
 *
 * The first version sourced the file — `set -a; . "$ENV_FILE"` — and died on a
 * live deployment with `line 9: PRIVATE: command not found`, because
 * `SIGNING_PRIVATE_KEY_PEM` is a PEM block spanning several lines and the shell
 * read its second line as a command. A preflight that cannot run on the one
 * file it exists to read is not a preflight.
 *
 * Sourcing was the wrong mechanism, not merely a fragile one. A `.env` is data,
 * and running it as a script means a value containing a backtick or `$(...)`
 * executes as whoever ran the check, which on a deployment is root. So the
 * fixture below carries the things that break a sourcing parser *and* the thing
 * that would make one dangerous, and asserts the check reads past all of them.
 */
describe('the wrapper reads a real .env rather than running it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'construx-envcheck-'));
  const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'object-store-check.sh');

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function write(body: string): string {
    const path = join(scratch, '.env');
    writeFileSync(path, body);
    return path;
  }

  async function wrapper(path: string): Promise<{ status: number; out: string }> {
    const child = spawn('bash', [WRAPPER, path], { env: { ...process.env } });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { out += chunk; });
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
    return { status, out };
  }

  it('reads past a multi-line PEM, a comment and a value full of spaces', async () => {
    allow = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'LIST']);
    corrupt = false;
    objects.clear();

    const path = write(
      [
        '# The deployment configuration.',
        'PUBLIC_BASE_URL=https://construxvg.com',
        'SIGNING_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
        'wEAAQJBAKm2b5Cy9nQKcCPDoO0lTLLEG3Pk1n0m6i8Yq0Ke8Pk',
        '-----END PRIVATE KEY-----',
        'NEWSLETTER_FROM_NAME=CONSTRUX Engineering Notes',
        `OBJECT_STORE_ENDPOINT=${endpoint}`,
        'OBJECT_STORE_REGION=eu-west-2',
        'OBJECT_STORE_BUCKET=construx',
        'OBJECT_STORE_ACCESS_KEY_ID=AKIDTESTONLY',
        'OBJECT_STORE_SECRET_ACCESS_KEY=not-a-real-credential',
        'OBJECT_STORE_PATH_STYLE=true',
        'OBJECT_STORE_TIMEOUT_MS=4000',
        'BACKUP_PREFIX=backups',
        '',
      ].join('\n'),
    );

    const { status, out } = await wrapper(path);
    assert.equal(status, 0, out);
    assert.match(out, /This store will hold the record/);
    assert.ok(!out.includes('command not found'), 'the wrapper is still running the file as a script');
  });

  it('does not execute what a value contains', async () => {
    // The reason this is parsed rather than sourced. Under `. .env` this line
    // would run `touch`, as whoever ran the check — root, on a deployment.
    const marker = join(scratch, 'executed');
    const path = write(
      [
        `NOTES=$(touch ${marker})`,
        `OBJECT_STORE_ENDPOINT=${endpoint}`,
        'OBJECT_STORE_REGION=eu-west-2',
        'OBJECT_STORE_BUCKET=construx',
        'OBJECT_STORE_ACCESS_KEY_ID=AKIDTESTONLY',
        'OBJECT_STORE_SECRET_ACCESS_KEY=not-a-real-credential',
        'OBJECT_STORE_PATH_STYLE=true',
        'OBJECT_STORE_TIMEOUT_MS=4000',
        '',
      ].join('\n'),
    );

    objects.clear();
    const { out } = await wrapper(path);
    assert.ok(!existsSync(marker), 'a value in .env was executed');
    assert.match(out, /Object store preflight/, out);
  });

  it('says which file it could not find rather than failing obscurely', async () => {
    const { status, out } = await wrapper(join(scratch, 'nowhere.env'));
    assert.equal(status, 1);
    assert.match(out, /No .*nowhere\.env here/);
  });
});
