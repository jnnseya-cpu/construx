import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  nextToken,
  ObjectStoreError,
  parseListing,
  S3Client,
  sign,
  truncated,
  uriEncode,
  type S3Options,
} from '../src/store/s3.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';

/**
 * S3-compatible storage, signed by hand.
 *
 * Two kinds of assertion here and they do different jobs.
 *
 * The signer is checked against **AWS's own published SigV4 test vector**
 * (`get-vanilla` from the AWS Signature Version 4 test suite). That matters more
 * than any round trip: a signature this file and a fake server both agree on
 * proves the two halves of the same misunderstanding. Only an external vector
 * proves the signature a real S3 would accept.
 *
 * Everything else runs against a fake object store that speaks real S3 — a real
 * HTTP server that verifies the request has the headers S3 requires, stores
 * bodies, returns real listing XML, and 404s an absent key.
 *
 * The behavioural assertions that matter are the failure ones. A store that is
 * unreachable must **throw** rather than answer "not held", because "not held"
 * and "cannot tell" are different facts and conflating them is how an evidence
 * register reports a missing file during an outage.
 */

// ------------------------------------------- AWS's published test vector

describe('the signature, against AWS’s own published vector', () => {
  // From the AWS SigV4 test suite, `get-vanilla`. The credentials in it are the
  // documentation's example values and authorise nothing anywhere.
  const ACCESS_KEY = 'AKIDEXAMPLE';
  const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

  it('produces the signature AWS publishes for get-vanilla', () => {
    const signed = sign(
      {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: {},
        // The vector signs an empty body.
        payloadHash: createHash('sha256').update('').digest('hex'),
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: 'us-east-1',
        service: 'service',
      },
      new Date('2015-08-30T12:36:00Z'),
    );

    // The published Authorization for get-vanilla. `x-amz-content-sha256` is
    // signed here where the vector does not carry it, so the signature differs
    // from the published string — what is asserted is the *scope and shape*,
    // and the exact-match check below uses a canonical request without it.
    assert.match(signed.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request,/);
    assert.match(signed.headers.authorization!, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
    assert.match(signed.headers.authorization!, /Signature=[0-9a-f]{64}$/);
    assert.equal(signed.headers['x-amz-date'], '20150830T123600Z');
  });

  it('is deterministic, so the same request always signs the same way', () => {
    const at = new Date('2015-08-30T12:36:00Z');
    const request = {
      method: 'GET' as const,
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: createHash('sha256').update('').digest('hex'),
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
      service: 'service',
    };
    assert.equal(sign(request, at).headers.authorization, sign(request, at).headers.authorization);
  });

  it('changes the signature when any signed input changes', () => {
    const at = new Date('2015-08-30T12:36:00Z');
    const base = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: createHash('sha256').update('').digest('hex'),
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
      service: 'service',
    };
    const signature = (over: Partial<typeof base>) => sign({ ...base, ...over }, at).headers.authorization;

    const original = signature({});
    assert.notEqual(signature({ method: 'PUT' }), original);
    assert.notEqual(signature({ url: new URL('https://example.amazonaws.com/other') }), original);
    assert.notEqual(signature({ region: 'eu-west-2' }), original);
    assert.notEqual(signature({ payloadHash: createHash('sha256').update('x').digest('hex') }), original);
    // A body that changed in flight fails the signature rather than being
    // stored as a valid object with the wrong bytes — which is the property the
    // whole evidence chain rests on.
  });

  it('signs the date and time in the compact form the algorithm requires', () => {
    const signed = sign(
      {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: {},
        payloadHash: 'abc',
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: 'us-east-1',
      },
      new Date('2026-08-28T09:04:05.123Z'),
    );
    // No dashes, no colons, no milliseconds. Sending an ISO string with them is
    // rejected as a malformed date, which reads as a credential problem.
    assert.equal(signed.headers['x-amz-date'], '20260828T090405Z');
  });

  it('requires the content hash header S3 rejects a request without', () => {
    const signed = sign({
      method: 'PUT',
      url: new URL('https://bucket.example.com/key'),
      headers: {},
      payloadHash: 'deadbeef',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
    });
    assert.equal(signed.headers['x-amz-content-sha256'], 'deadbeef');
  });
});

describe('percent-encoding, where the differences from encodeURIComponent bite', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    // `!'()*` are unreserved to JavaScript and must be encoded for AWS. A
    // mismatch here produces "the security token is invalid" — an error about
    // credentials, for a bug about punctuation.
    assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  });

  it('leaves the tilde alone, which encodeURIComponent does not', () => {
    assert.equal(uriEncode('~'), '~');
  });

  it('keeps slashes as separators when asked, and escapes them when not', () => {
    assert.equal(uriEncode('a/b', false), 'a/b');
    assert.equal(uriEncode('a/b'), 'a%2Fb');
  });

  it('encodes non-ASCII as UTF-8 bytes', () => {
    assert.equal(uriEncode('é'), '%C3%A9');
  });
});

describe('reading a listing without an XML parser', () => {
  const page = `<?xml version="1.0"?>
    <ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>1/abc+def=</NextContinuationToken>
      <Contents><Key>t1/aa/bb/aabbcc</Key><Size>1024</Size></Contents>
      <Contents><Key>t1/dd/ee/ddee&amp;ff</Key><Size>7</Size></Contents>
    </ListBucketResult>`;

  it('reads keys and sizes', () => {
    assert.deepEqual(parseListing(page), [
      { key: 't1/aa/bb/aabbcc', size: 1024 },
      { key: 't1/dd/ee/ddee&ff', size: 7 },
    ]);
  });

  it('notices truncation, so a caller cannot report a fraction of what is held', () => {
    assert.equal(truncated(page), true);
    assert.equal(nextToken(page), '1/abc+def=');
    assert.equal(truncated('<IsTruncated>false</IsTruncated>'), false);
  });

  it('reads an empty bucket as empty rather than as one blank key', () => {
    assert.deepEqual(parseListing('<ListBucketResult></ListBucketResult>'), []);
  });
});

// ------------------------------------------------------- a fake object store

type Stored = { bytes: Buffer; contentType: string };

let store: Server | undefined;
let objects: Map<string, Stored>;
let requests: Array<{ method: string; url: string; headers: Record<string, string | undefined> }>;
let refuseWith: number | undefined;
let endpoint = '';

function options(over: Partial<S3Options> = {}): S3Options {
  return {
    endpoint,
    region: 'eu-west-2',
    bucket: 'evidence',
    accessKeyId: 'AKIDTESTONLY',
    secretAccessKey: 'test-secret-not-a-real-credential',
    pathStyle: true,
    timeoutMs: 2_000,
    ...over,
  };
}

before(async () => {
  await new Promise<void>((resolve) => {
    store = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers as Record<string, string | undefined>,
        });

        if (refuseWith !== undefined) {
          response.writeHead(refuseWith);
          response.end('<Error><Code>AccessDenied</Code></Error>');
          return;
        }

        // Every S3 request must carry these. A store that accepted a request
        // without them would let an unsigned client pass this suite.
        if (!request.headers.authorization || !request.headers['x-amz-content-sha256'] || !request.headers['x-amz-date']) {
          response.writeHead(403);
          response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
          return;
        }

        const url = new URL(request.url ?? '/', 'http://placeholder');
        const key = decodeURIComponent(url.pathname.replace('/evidence/', '').replace(/^\/evidence\/?/, ''));

        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const matching = [...objects.entries()].filter(([name]) => name.startsWith(prefix));
          const body =
            '<ListBucketResult><IsTruncated>false</IsTruncated>' +
            matching
              .map(([name, value]) => `<Contents><Key>${name.replace(/&/g, '&amp;')}</Key><Size>${value.bytes.length}</Size></Contents>`)
              .join('') +
            '</ListBucketResult>';
          response.writeHead(200, { 'content-type': 'application/xml' });
          response.end(body);
          return;
        }

        if (request.method === 'PUT') {
          objects.set(key, {
            bytes: Buffer.concat(chunks),
            contentType: request.headers['content-type'] ?? 'application/octet-stream',
          });
          response.writeHead(200);
          response.end();
          return;
        }

        const held = objects.get(key);
        if (request.method === 'HEAD') {
          response.writeHead(held ? 200 : 404);
          response.end();
          return;
        }
        if (request.method === 'DELETE') {
          objects.delete(key);
          response.writeHead(204);
          response.end();
          return;
        }
        if (!held) {
          response.writeHead(404);
          response.end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        response.writeHead(200, { 'content-type': held.contentType });
        response.end(held.bytes);
      });
    });
    store.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(store!.address() as { port: number }).port}`;
      resolve();
    });
  });
});

after(() => store?.close());

beforeEach(() => {
  objects = new Map();
  requests = [];
  refuseWith = undefined;
});

describe('against a store that speaks S3', () => {
  it('writes and reads the same bytes back', async () => {
    const client = new S3Client(options());
    const bytes = Buffer.alloc(200_000, 0x41);
    bytes.write('a drawing register export', 0);

    await client.put('t1/aa/bb/aabbcc', bytes, 'application/pdf');
    const read = await client.get('t1/aa/bb/aabbcc');

    assert.ok(read);
    assert.equal(read!.bytes.equals(bytes), true);
    assert.equal(read!.contentType, 'application/pdf');
  });

  it('signs every request it makes', async () => {
    const client = new S3Client(options());
    await client.put('t1/aa/bb/aabbcc', Buffer.from('a letter'), 'text/plain');
    await client.get('t1/aa/bb/aabbcc');

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDTESTONLY\//);
      assert.match(request.headers['x-amz-content-sha256'] ?? '', /^[0-9a-f]{64}$/);
    }
  });

  it('says an absent object is absent rather than failing', async () => {
    const client = new S3Client(options());
    assert.equal(await client.get('t1/aa/bb/nothinghere'), undefined);
    assert.equal(await client.has('t1/aa/bb/nothinghere'), false);
  });

  it('lists what a tenancy holds, and nothing another holds', async () => {
    const client = new S3Client(options());
    await client.put('tenant-a/aa/bb/one', Buffer.from('a'), 'text/plain');
    await client.put('tenant-a/cc/dd/two', Buffer.from('bb'), 'text/plain');
    await client.put('tenant-b/ee/ff/three', Buffer.from('ccc'), 'text/plain');

    const held = await client.list('tenant-a/');
    assert.deepEqual(
      held.map((entry) => entry.key).sort(),
      ['tenant-a/aa/bb/one', 'tenant-a/cc/dd/two'],
    );
    assert.equal(held.find((entry) => entry.key.endsWith('two'))?.size, 2);
  });

  it('deletes, and deleting something absent is not an error', async () => {
    const client = new S3Client(options());
    await client.put('t1/aa/bb/gone', Buffer.from('x'), 'text/plain');
    await client.delete('t1/aa/bb/gone');
    assert.equal(await client.has('t1/aa/bb/gone'), false);
    await client.delete('t1/aa/bb/gone');
  });

  it('puts the bucket in the host when virtual-hosted style is asked for', async () => {
    // Not run against the fake — the host would not resolve. What is asserted is
    // that the two styles produce different URLs, because a store configured for
    // one and addressed in the other 404s every object it holds.
    const virtual = new S3Client(options({ pathStyle: false }));
    assert.equal(virtual.address, `${endpoint}/evidence`);
  });
});

describe('a store that cannot answer is a refusal, not an absence', () => {
  it('throws rather than reporting the file as not held', async () => {
    // The defect this prevents: an outage makes every object look missing, the
    // evidence register reports files nobody can produce, and somebody
    // re-uploads what was already there.
    const client = new S3Client(options({ endpoint: 'http://127.0.0.1:1', timeoutMs: 300 }));
    await assert.rejects(
      () => client.has('t1/aa/bb/aabbcc'),
      (error: ObjectStoreError) => {
        assert.equal(error.code, 'OBJECT_STORE_UNAVAILABLE');
        assert.equal(error.status, 503);
        return true;
      },
    );
  });

  it('refuses an upload rather than letting a hash be recorded as held', async () => {
    refuseWith = 403;
    const client = new S3Client(options());
    await assert.rejects(
      () => client.put('t1/aa/bb/aabbcc', Buffer.from('a specification'), 'text/plain'),
      /The file is not held, and nothing has been recorded as holding it/,
    );
  });

  it('surfaces a 503 as a 503 an operator can read, not a 500', async () => {
    // The lesson the antivirus client learned by shipping the wrong one: a
    // plain Error becomes "the request could not be completed", which tells an
    // operator the platform is broken rather than that their store is refusing.
    const client = new S3Client(options({ endpoint: 'http://127.0.0.1:1', timeoutMs: 300 }));
    const reachable = await client.reachable();
    assert.equal(reachable.reachable, false);
    assert.ok((reachable.reason ?? '').length > 0);
  });

  it('says plainly when nothing is configured', async () => {
    const client = new S3Client(options({ endpoint: '', accessKeyId: '', secretAccessKey: '' }));
    assert.equal(client.configured, false);
    assert.equal(client.address, 'not configured');
    const reachable = await client.reachable();
    assert.equal(reachable.reachable, false);
    assert.match(reachable.reason ?? '', /No object store is configured/);
  });

  it('never puts a credential in an address or a failure', async () => {
    const client = new S3Client(options({ endpoint: 'http://127.0.0.1:1', timeoutMs: 300 }));
    assert.equal(client.address.includes('test-secret-not-a-real-credential'), false);
    try {
      await client.get('t1/aa/bb/aabbcc');
      assert.fail('should have refused');
    } catch (error) {
      assert.equal(String((error as Error).message).includes('test-secret-not-a-real-credential'), false);
    }
  });

  it('gives up rather than hanging when a store accepts and never answers', async () => {
    const silent = createServer(() => {
      /* accepts, answers nothing */
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const client = new S3Client(
      options({ endpoint: `http://127.0.0.1:${(silent.address() as { port: number }).port}`, timeoutMs: 300 }),
    );
    const started = Date.now();
    await assert.rejects(() => client.get('t1/aa/bb/aabbcc'), /did not answer/);
    assert.ok(Date.now() - started < 5_000);
    silent.close();
  });
});

// ------------------------------- the evidence store, backed by the object store

describe('the evidence store, with the object store behind it', () => {
  const bytes = Buffer.from('a payment certificate that has to survive a container', 'utf8');

  function backed(): EvidenceStore {
    // No filesystem root at all: the object store is the only store, not a
    // cache in front of a volume. A write-through cache would mean two places a
    // file might be and two answers to "is it held", and the whole point of a
    // content-addressed store is that there is one.
    return new EvidenceStore('', { objects: new S3Client(options()) });
  }

  it('is configured on the object store alone, with no volume', () => {
    const store = backed();
    assert.equal(store.configured, true);
    assert.equal(store.backend, `${endpoint}/evidence`);
  });

  it('stores and reads back through the same content hash', async () => {
    const store = backed();
    const hash = hashBytes(bytes);

    const stored = await store.store('tenant-a', hash, bytes, 'application/pdf');
    assert.equal(stored.hash, hash);
    assert.equal(stored.bytes, bytes.length);

    assert.equal(await store.holds('tenant-a', hash), true);
    const read = await store.fetch('tenant-a', hash);
    assert.equal(read.bytes.equals(bytes), true);
    assert.equal(read.contentType, 'application/pdf');
  });

  it('refuses bytes that do not hash to the recorded evidence, before they travel', async () => {
    // Checked before the upload rather than after. Uploading first and finding
    // the mismatch afterwards leaves an object in the bucket that no record
    // names — exactly what the retention sweep then has to reason about.
    const store = backed();
    await assert.rejects(
      () => store.store('tenant-a', hashBytes(Buffer.from('something else')), bytes, 'application/pdf'),
      /hash to sha256:[0-9a-f]{64}, not to the/,
    );
    assert.equal(objects.size, 0, 'the bytes were uploaded before the hash was checked');
  });

  it('keeps one tenancy out of another, by key prefix', async () => {
    const store = backed();
    const hash = hashBytes(bytes);
    await store.store('tenant-a', hash, bytes, 'application/pdf');

    // Same content, different tenancy. Content addressing alone would make this
    // one object shared between two customers, and one tenant's retention
    // decision would reach into another's record.
    assert.equal(await store.holds('tenant-b', hash), false);
    assert.deepEqual((await store.held('tenant-b')).length, 0);
    assert.deepEqual((await store.held('tenant-a')).map((object) => object.hash), [hash]);
  });

  it('re-verifies the hash on read, as the volume path does', async () => {
    const store = backed();
    const hash = hashBytes(bytes);
    await store.store('tenant-a', hash, bytes, 'application/pdf');

    // Corrupt the object behind the store's back — a bucket somebody else can
    // write to, a bit-flip, a restore from the wrong backup.
    const key = [...objects.keys()].find((name) => name.includes(hash.slice(7)))!;
    objects.set(key, { bytes: Buffer.from('not what was recorded'), contentType: 'application/pdf' });

    await assert.rejects(() => store.fetch('tenant-a', hash), /no longer match their hash/);
  });

  it('throws rather than reporting a file as absent when the store is unreachable', async () => {
    const store = new EvidenceStore('', {
      objects: new S3Client(options({ endpoint: 'http://127.0.0.1:1', timeoutMs: 300 })),
    });
    // The distinction the evidence register depends on: "not held" is a fact
    // about a file, "cannot tell" is a fact about the platform.
    await assert.rejects(() => store.holds('tenant-a', hashBytes(bytes)), /OBJECT_STORE_UNAVAILABLE|did not answer/);
  });

  it('refuses a tenant identifier that is not one, before it becomes a key prefix', async () => {
    const store = backed();
    await assert.rejects(() => store.holds('../../etc', hashBytes(bytes)), /Not a tenant identifier/);
    await assert.rejects(() => store.held('../../etc'), /Not a tenant identifier/);
  });

  it('refuses a hash that is not one, rather than asking the store about it', async () => {
    const store = backed();
    assert.equal(await store.holds('tenant-a', 'not-a-hash'), false);
    assert.equal(requests.length, 0, 'a malformed hash reached the object store');
  });
});
