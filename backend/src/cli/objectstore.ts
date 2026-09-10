import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { hashBytes } from '../evidence/store.ts';
import { S3Client } from '../store/s3.ts';

/**
 * Does the object store in this `.env` actually work?
 *
 * Everything the off-host backup needs was built and tested: the SigV4 signer
 * against AWS's own published vector, the shipper, the manifest, the restore
 * drill, the readiness line and the watch rule. What none of it could answer is
 * the only question an operator has on the day they create a bucket — **are
 * these five values right**.
 *
 * Until this existed the answer came from restarting the service and reading a
 * screen, which conflates three different failures into one red line: a
 * typo in the endpoint, a key without write permission, and a bucket in a
 * region the endpoint does not serve all look identical from the outside. Worse,
 * a deployment can sit with a wrong secret for six hours and discover it when
 * the first backup set is missed — which is to say, discover it from the alarm
 * that exists for a lost volume.
 *
 * So: a round trip against the real store, before anything depends on it.
 * Write an object, read it back, compare the bytes, see it in a listing, delete
 * it, confirm it is gone. Every step named, and a failure reported in the
 * store's own words rather than translated.
 *
 * **It writes and then removes exactly one small object**, under the backup
 * prefix in a `.preflight/` folder with a random name, so it cannot collide
 * with a real set and cannot be mistaken for one. Nothing else in the bucket is
 * read, listed or touched.
 *
 * **No secret is printed.** The endpoint and the bucket are shown because an
 * operator has to see which store answered; the key id and the secret are
 * never echoed, not even truncated — a partial secret in a terminal history is
 * still a secret in a terminal history.
 *
 * Run it with the deployment's environment loaded:
 *
 *     ./deploy/object-store-check.sh /srv/construx/app/.env
 *
 * Exit 0 means the credentials are good for everything the platform asks of
 * them. Exit 1 names which step failed and why.
 */

type Step = { name: string; ok: boolean; detail: string };

const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string): boolean {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}\n        ${detail}\n`);
  return ok;
}

/** The five values, and which of them are absent. Named, not counted. */
function missingKeys(): string[] {
  const required: Array<[string, string]> = [
    ['OBJECT_STORE_ENDPOINT', config.objectStore.endpoint],
    ['OBJECT_STORE_BUCKET', config.objectStore.bucket],
    ['OBJECT_STORE_ACCESS_KEY_ID', config.objectStore.accessKeyId],
    ['OBJECT_STORE_SECRET_ACCESS_KEY', config.objectStore.secretAccessKey],
  ];
  return required.filter(([, value]) => value.trim() === '').map(([name]) => name);
}

/**
 * The mistakes that produce a signature error rather than an obvious one.
 *
 * Reported as advice, never as a failure: a deployment that works while
 * disagreeing with this list is working, and a check that refuses a valid
 * configuration because it looks unusual is a check somebody stops running.
 */
function advice(): string[] {
  const notes: string[] = [];
  const endpoint = config.objectStore.endpoint;

  if (endpoint !== '' && !endpoint.startsWith('https://')) {
    notes.push(`OBJECT_STORE_ENDPOINT is "${endpoint}" — every credential and every byte of the record crosses this in the clear unless it is https.`);
  }
  if (endpoint.endsWith('/')) {
    notes.push('OBJECT_STORE_ENDPOINT ends in a slash, which produces a double slash in the signed path and a signature that will not match.');
  }
  if (endpoint.includes(`/${config.objectStore.bucket}`) && config.objectStore.bucket !== '') {
    notes.push('OBJECT_STORE_ENDPOINT already contains the bucket name. The endpoint is the host only; the bucket goes in OBJECT_STORE_BUCKET.');
  }
  // Cloudflare R2 signs against `auto` and serves path style. Both are the
  // defaults nobody guesses, and each one wrong reads as "the security token
  // is invalid" — an error about credentials, for a bug about a region string.
  if (endpoint.includes('r2.cloudflarestorage.com')) {
    if (config.objectStore.region !== 'auto') {
      notes.push(`This is a Cloudflare R2 endpoint and OBJECT_STORE_REGION is "${config.objectStore.region}". R2 signs against "auto".`);
    }
    if (!config.objectStore.pathStyle) {
      notes.push('This is a Cloudflare R2 endpoint and OBJECT_STORE_PATH_STYLE is false. R2 serves path style.');
    }
  }
  if (config.backup.intervalMinutes <= 0) {
    notes.push('BACKUP_INTERVAL_MINUTES is 0, so nothing is shipped on a timer even once this passes. The store is still used for evidence.');
  }
  return notes;
}

async function main(): Promise<void> {
  const absent = missingKeys();
  if (absent.length > 0) {
    process.stdout.write('No object store is configured on this deployment.\n\n');
    process.stdout.write(`Not set: ${absent.join(', ')}\n\n`);
    process.stdout.write(
      'Without them the record exists on one volume, the evidence store falls back to that volume,\n' +
        'and a lost host is a lost company. deploy/env-check.sh reports the same thing.\n',
    );
    process.exit(1);
  }

  const client = new S3Client(config.objectStore);
  process.stdout.write(`Object store preflight\n\n  ${client.address}\n  region ${config.objectStore.region}, ${config.objectStore.pathStyle ? 'path' : 'virtual-hosted'} style\n\n`);

  // A name that cannot collide with a real set and cannot be mistaken for one.
  const key = `${config.backup.prefix}/.preflight/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.txt`;
  const bytes = Buffer.from(
    `CONSTRUX object store preflight\nwritten ${new Date().toISOString()}\nThis object is deleted by the same run that wrote it.\n`,
    'utf8',
  );
  const digest = hashBytes(bytes);

  const listed = await client.reachable();
  if (!record('The bucket answers, and the credentials are accepted', listed.reachable, listed.reachable ? 'A signed listing returned. The endpoint, region, bucket and key all agree.' : (listed.reason ?? 'no reason given'))) {
    return finish(key, client);
  }

  try {
    await client.put(key, bytes, 'text/plain; charset=utf-8');
    record('Write', true, `Put ${bytes.length} bytes at ${key}`);
  } catch (error) {
    record('Write', false, `${error instanceof Error ? error.message : String(error)} — the credential can list but not write, which is the permission a backup needs.`);
    return finish(key, client);
  }

  const read = await client.get(key).catch((error: unknown) => {
    record('Read back', false, error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (read === undefined) {
    if (steps.at(-1)?.name !== 'Read back') record('Read back', false, 'The object written a moment ago was not found.');
    return finish(key, client);
  }
  // Byte-for-byte, not merely present. A store that accepts a write and
  // returns something else is worse than one that refuses the write.
  record(
    'Read back, byte for byte',
    hashBytes(read.bytes) === digest,
    hashBytes(read.bytes) === digest ? 'The bytes returned are the bytes sent.' : 'What came back is not what went up.',
  );

  const listing = await client.list(`${config.backup.prefix}/.preflight/`).catch(() => []);
  record(
    'Appears in a listing',
    listing.some((entry) => entry.key === key),
    listing.some((entry) => entry.key === key)
      ? 'The shipper finds a set by listing, so a store that writes but does not list would ship and never restore.'
      : 'The object was written and does not appear in a listing of its own prefix.',
  );

  await finish(key, client);
}

/**
 * Remove the object, whatever happened above, and report.
 *
 * The delete is a check as well as a tidy-up: the backup rotation removes sets
 * beyond `BACKUP_KEEP`, so a credential that cannot delete fills the bucket
 * quietly until somebody gets a bill.
 */
async function finish(key: string, client: S3Client): Promise<void> {
  // The consequence is said on both paths. A refused delete and a delete that
  // silently left the object behind are the same fault to whoever pays for the
  // bucket, and the first draft of this explained it only on one of them.
  const why = 'The rotation deletes sets beyond BACKUP_KEEP, so a credential that cannot delete fills the bucket until somebody gets a bill.';
  if (steps.some((step) => step.name.startsWith('Write') && step.ok)) {
    try {
      await client.delete(key);
      const gone = !(await client.has(key));
      record('Delete', gone, gone ? why : `${why} The object is still there after a delete that reported success, and must be removed by hand: ${key}`);
    } catch (error) {
      record('Delete', false, `${error instanceof Error ? error.message : String(error)}. ${why} The preflight object must be removed by hand: ${key}`);
    }
  }

  const notes = advice();
  if (notes.length > 0) {
    process.stdout.write('\nWorth checking\n');
    for (const note of notes) process.stdout.write(`  - ${note}\n`);
  }

  const failed = steps.filter((step) => !step.ok);
  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write(
      `${steps.length} of ${steps.length} passed. This store will hold the record.\n` +
        `Restart the service and the first set lands within ${config.backup.intervalMinutes} minutes;\n` +
        'GET /v1/admin/backups is the position, and Off-host backup on System Control turns green.\n',
    );
    process.exit(0);
  }
  process.stdout.write(`${failed.length} of ${steps.length} failed: ${failed.map((step) => step.name).join(', ')}.\n`);
  process.stdout.write('Nothing has been changed. Fix the values in .env and run this again before restarting the service.\n');
  process.exit(1);
}

await main();
